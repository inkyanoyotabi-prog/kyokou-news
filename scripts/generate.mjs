// 虚構ニュース：記事をAIに書かせる
//   Gemini … タイトルと本文を書く → チェックする
//   OpenAI … 合格した記事に合う絵（写真ふう）を1枚描く（最後に描くので、不合格の記事の絵にお金を使わない）
// 二重に書かせない作り：記事IDは「日付_時刻」で決まる。すでにあるIDは作らない。
// 呼び出し回数の上限（MAX_CALLS）を超えたら、その場で止める。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ARTICLES = path.join(ROOT, 'docs', 'articles.json');
const IMG_DIR = path.join(ROOT, 'docs', 'img');
const SPARES = path.join(ROOT, 'yobi.json');
const EVENTS = path.join(ROOT, 'tokubetsu.json'); // 特別な日（夜旅さんが自由に足せる）

const SLOTS = ['07:00', '12:00', '15:00', '18:00', '21:00'];
const EVENT_SLOTS = ['07:00', '18:00']; // 特別な日は、この2本をその日にちなんだ記事にする
const KEEP_DAYS = 30;
const SPARE_TARGET = 3;

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-2';
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || 'low';
const IMAGE_SIZE = process.env.IMAGE_SIZE || '1536x1024';
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = Number(process.env.LIMIT || 0);          // 試しに少しだけ作るとき（1なら1本だけ）
const MAX_CALLS = Number(process.env.MAX_CALLS || 40); // 1回の実行で呼べる上限（2社の合計）
// 100万トークンあたりのドル（目安の料金の計算用）
const PRICE = {
  gemini: { in: Number(process.env.GEMINI_IN_PRICE || 0.75), out: Number(process.env.GEMINI_OUT_PRICE || 3.75) },
  openai: { in: Number(process.env.IMAGE_IN_PRICE || 5.00), out: Number(process.env.IMAGE_OUT_PRICE || 30.00) },
};
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();

const CATEGORIES = ['社会', '経済', '科学', '地域', 'スポーツ', '生活', '動物', '文化'];

const NG = /地震|津波|台風|豪雨|噴火|殺人|殺害|殺さ|殺し|死亡|死者|死去|遺体|逮捕|容疑|書類送検|起訴|事件|テロ|戦争|紛争|爆発|爆破|選挙|首相|総理|大統領|天皇|皇室|国会議員|自民|立憲|公明|維新|共産党|宗教|教団|がん|癌|ウイルス|感染|自殺|性的|差別|ナチ|ヒトラー/;

let calls = 0;
const use = { gemini: { calls: 0, in: 0, out: 0 }, openai: { calls: 0, in: 0, out: 0 } };
const log = (...a) => console.log(...a);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function jstDate(d) {
  const j = new Date(d.getTime() + 9 * 3600e3);
  return j.toISOString().slice(0, 10);
}
function slotTime(date, hhmm) { return new Date(`${date}T${hhmm}:00+09:00`); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRY_STATUS = [429, 500, 502, 503, 504];
const RETRY_WAIT = Number(process.env.RETRY_WAIT || 30000);

function countCall(who) {
  if (calls >= MAX_CALLS) throw new Error(`呼び出し上限（${MAX_CALLS}回）に達したので止めました`);
  calls++; use[who].calls++;
}

// 混み合い（503など）のときは、少し待ってからもう1回だけ呼ぶ
async function post(who, url, headers, body) {
  for (let i = 1; i <= 2; i++) {
    countCall(who);
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    const msg = `${who}の呼び出しに失敗: ${res.status} ${JSON.stringify(data).slice(0, 200)}`;
    if (i === 1 && RETRY_STATUS.includes(res.status)) { log('  ' + msg + ' → 少し待ってもう1回'); await sleep(RETRY_WAIT); continue; }
    throw new Error(msg);
  }
}

// 文章係・チェック係（Gemini）
async function callGemini(prompt) {
  if (DRY_RUN) { countCall('gemini'); return fakeGemini(prompt); }
  const data = await post('gemini', `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 1.0 },
    });
  const u = data.usageMetadata || {};
  use.gemini.in += u.promptTokenCount || 0;
  use.gemini.out += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  return JSON.parse(text);
}

// 絵の係（OpenAI）。webp の画像データを返す
async function callImage(prompt) {
  if (DRY_RUN) { countCall('openai'); return fakeImage(); }
  const data = await post('openai', 'https://api.openai.com/v1/images/generations',
    { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
    { model: IMAGE_MODEL, prompt, size: IMAGE_SIZE, quality: IMAGE_QUALITY, output_format: 'webp', output_compression: 75, n: 1 });
  use.openai.in += data.usage?.input_tokens || 0;
  use.openai.out += data.usage?.output_tokens || 0;
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('絵が返ってきませんでした');
  return Buffer.from(b64, 'base64');
}

// 試運転用の偽AI（DRY_RUN=1 のときだけ）
let fakeN = 0;
function fakeGemini(prompt) {
  if (prompt.startsWith('#CHECK')) return { ok: !prompt.includes('地震'), reason: '' };
  fakeN++;
  const bad = process.env.FAKE_BAD && fakeN <= Number(process.env.FAKE_BAD);
  return {
    category: '地域',
    headline: bad ? `地震で町が揺れる（テスト${fakeN}）` : `ねこ町議会、昼寝を公務と認定（テスト${fakeN}）`,
    body: 'ねこ町議会は二十三日、昼寝を正式な公務と認める条例案を全会一致で可決した。\n\n町によると、議員の八割が会議中に眠っていたことから「実態に合わせた」という。\n\n来年度からは昼寝手当も支給される見通し。町長は「起きている議員の方が少数派だった。民意を反映した」と胸を張った。一方、町内の枕店には注文が殺到しているという。',
    scene: 'A small town council chamber where several cats in tiny suits are napping in their seats',
  };
}
function fakeImage() {
  if (process.env.FAKE_IMAGE_FAIL) throw new Error('openaiの呼び出しに失敗: 500 (テスト)');
  return Buffer.from('RIFF0000WEBPfake');
}

const RULES = `## 絶対に守ること
- 人名・地名・会社名・団体名・商品名は、すべて実在しない架空のものにする（例：もぐら市、株式会社ほたて工業）。実在の国名・都道府県名・市町村名・有名人・政治家・企業・ブランド・作品名は使わない。
- 次の話題は書かない：選挙・政党・政治家、災害、事故、死亡、病気、犯罪・逮捕、戦争・テロ、宗教、民族・国籍・性別・障害などへの差別や揶揄、性的な内容、実在の報道機関のまね。
- 特定の誰かを傷つけたり、本当のニュースと勘違いされたりする内容にしない。`;

function eventNote(ev) {
  return ev ? `\n## 今日は「${ev}」\nこの日にちなんだ、くだらない話題にする。行事の楽しい面だけを扱い、宗教や歴史上の悲しい出来事には触れない。\n` : '';
}

function writePrompt(recent, ev) {
  return `あなたは架空のニュースサイトの記者です。日本語の「虚構ニュース」を1本書いてください。
${eventNote(ev)}
## 書き方
- 本物の新聞のような、まじめで落ち着いた文体。内容はばかばかしく、読んで笑えるもの。
- タイトルは28文字以内。本物の新聞の見出しのような、簡潔な言い回し。
- 本文は250〜450文字。3〜4段落。段落の間は空行（\\n\\n）。
- 「フィクション」「架空」「ジョーク」などの断り書きは本文に書かない。
- scene には、記事に添える写真の場面を英語で1〜2文で書く。写っているもの（動物・物・風景・後ろ姿の人など）を具体的に。人の顔がはっきり写る場面、文字や看板が主役の場面は避ける。

${RULES}

## 最近のタイトル（同じ話題・同じ型をくり返さない）
${recent.map(h => '- ' + h).join('\n') || '- （まだなし）'}

## 出力
次のJSONだけを返す：
{"category": "${CATEGORIES.join('|')}のどれか", "headline": "タイトル", "body": "本文", "scene": "写真の場面（英語）"}`;
}

function checkPrompt(a) {
  return `#CHECK
次の架空ニュース記事が、下の条件をすべて守っているか判定してください。

条件：
1. 実在の人物・国・都道府県・市町村・企業・団体・商品・作品の名前が出てこない。
2. 選挙・政治家、災害、事故、死亡、病気、犯罪、戦争・テロ、宗教、差別、性的な内容を扱っていない。
3. 本物のニュースと勘違いされるような、もっともらしい嘘になっていない（ばかばかしさで冗談だとわかる）。
4. 誰かを傷つける・揶揄する内容ではない。
5. 本文がタイトルの内容に合っている。
6. 写真の場面（scene）に、実在の人物・有名な建物や場所・ロゴ・ブランド・危険な場面・不快な場面が含まれていない。
（七夕・クリスマスなどの年中行事を楽しい話題として扱うのは問題ない）

記事：
タイトル：${a.headline}
本文：${a.body}
写真の場面：${a.scene}

次のJSONだけを返す：{"ok": true または false, "reason": "falseのときの理由（短く）"}`;
}

function imagePrompt(a) {
  return `A candid documentary-style news photograph for a humorous fictional story. Scene: ${a.scene}
Style: natural light, realistic photo, slightly playful mood.
Strict rules: no text, no letters, no signs with writing, no logos, no brand names, no real or famous people, no recognizable faces (people only from behind or far away), no real landmarks, no flags, nothing violent, scary or sad.`;
}

async function makeOne(recent, ev) {
  for (let attempt = 1; attempt <= 2; attempt++) { // やり直しは1回まで
    // 1. タイトルと本文（Gemini）
    const a = await callGemini(writePrompt(recent, ev));
    const ok = a && typeof a.headline === 'string' && typeof a.body === 'string'
      && a.headline.trim() && a.headline.length <= 40 && a.body.length >= 100 && a.body.length <= 900;
    if (!ok) { log(`  形がおかしいので不採用（${attempt}回目）`); continue; }
    const art = { category: CATEGORIES.includes(a.category) ? a.category : '社会', headline: a.headline.trim(), body: a.body.trim(), scene: String(a.scene || '').trim() };
    if (NG.test(art.headline + art.body)) { log(`  禁止語が入っていたので不採用（${attempt}回目）: ${art.headline}`); continue; }
    // 2. チェック（Gemini）
    const c = await callGemini(checkPrompt(art));
    if (!c || c.ok !== true) { log(`  チェックで不採用（${attempt}回目）: ${art.headline} / ${c?.reason || ''}`); continue; }
    return art;
  }
  return null;
}

// 3. 絵（OpenAI）。失敗したら絵なしで出す
async function addImage(art, id) {
  if (!art.scene) { log('  場面の説明がないので絵なし'); return; }
  try {
    const buf = await callImage(imagePrompt(art));
    fs.mkdirSync(IMG_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMG_DIR, `${id}.webp`), buf);
    art.image = `img/${id}.webp`;
    log(`  絵: ${art.image}（${Math.round(buf.length / 1024)}KB）`);
  } catch (e) {
    log(`  絵は作れませんでした（絵なしで出します）: ${e.message}`);
  }
}

// お金のかからない確認：使うモデルが本当に使えるかを、記事を書かせる前に確かめる
async function preflight() {
  const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`, { headers: { 'x-goog-api-key': GEMINI_KEY } });
  if (!g.ok) throw new Error(`Geminiのモデル ${GEMINI_MODEL} が使えません（${g.status}）。何も書かせずに止めました`);
  const o = await fetch(`https://api.openai.com/v1/models/${IMAGE_MODEL}`, { headers: { authorization: `Bearer ${OPENAI_KEY}` } });
  if (!o.ok) throw new Error(`OpenAIのモデル ${IMAGE_MODEL} が使えません（${o.status}）。何も書かせずに止めました`);
}

async function main() {
  if (!DRY_RUN && !GEMINI_KEY) throw new Error('GEMINI_API_KEY が設定されていません');
  if (!DRY_RUN && !OPENAI_KEY) throw new Error('OPENAI_API_KEY が設定されていません');
  if (!DRY_RUN) await preflight();

  const store = readJson(ARTICLES, { articles: [] });
  const spares = readJson(SPARES, { spares: [] });
  const have = new Set(store.articles.map(a => a.id));
  const events = readJson(EVENTS, {});

  // 作る枠を決める（今日の残りと明日。過去の枠は作らない）
  const today = jstDate(NOW);
  const tomorrow = jstDate(new Date(NOW.getTime() + 864e5));
  let need = [];
  for (const d of [today, tomorrow]) for (const s of SLOTS) {
    const id = `${d}_${s.replace(':', '')}`;
    if (slotTime(d, s) > NOW && !have.has(id)) need.push({ id, date: d, slot: s });
  }
  need = [...new Map(need.map(n => [n.id, n])).values()]; // 同じ枠を2回入れない
  if (LIMIT > 0) need = need.slice(0, LIMIT);
  log(`作る枠: ${need.length}本 ${need.map(n => n.id).join(', ') || '（なし）'}`);

  const recent = store.articles.slice(-40).map(a => a.headline);
  let added = 0, usedSpare = 0, empty = 0, images = 0, stopped = false;

  for (const n of need) {
    if (have.has(n.id)) continue; // 念のため送る直前にもう一度確かめる
    log(`[${n.id}]`);
    const ev = EVENT_SLOTS.includes(n.slot) ? events[n.date.slice(5)] : null;
    if (ev) log(`  特別な日: ${ev}`);
    let a = null, geminiDown = false;
    try { a = await makeOne(recent, ev); } catch (e) { log('  ' + e.message); geminiDown = true; }
    if (!a && spares.spares.length) { a = spares.spares.shift(); usedSpare++; log('  予備記事を使いました'); }
    if (!a) { empty++; log('  この枠は空きのままです'); if (geminiDown) { stopped = true; break; } continue; }
    const art = { id: n.id, publishAt: `${n.date}T${n.slot}:00+09:00`, category: a.category, headline: a.headline, body: a.body, scene: a.scene };
    await addImage(art, n.id);
    if (art.image) images++;
    delete art.scene;
    store.articles.push(art);
    have.add(n.id);
    added++;
    recent.push(art.headline);
    log(`  → ${art.headline}`);
  }

  // 予備記事を補充（試しの実行では作らない。絵は使うときに描く）
  if (LIMIT === 0 && !stopped) {
    while (spares.spares.length < SPARE_TARGET && calls + 4 <= MAX_CALLS) {
      log('[予備]');
      const a = await makeOne(recent).catch(e => { log('  ' + e.message); return null; });
      if (!a) break;
      spares.spares.push(a); recent.push(a.headline);
      log(`  → ${a.headline}`);
    }
  }

  // 古い記事と、その絵を片づける
  const cutoff = NOW.getTime() - KEEP_DAYS * 864e5;
  store.articles = store.articles
    .filter(a => new Date(a.publishAt).getTime() >= cutoff)
    .sort((x, y) => x.publishAt.localeCompare(y.publishAt));
  const keepImg = new Set(store.articles.map(a => a.image).filter(Boolean).map(p => path.basename(p)));
  if (fs.existsSync(IMG_DIR)) for (const f of fs.readdirSync(IMG_DIR)) if (!keepImg.has(f)) fs.unlinkSync(path.join(IMG_DIR, f));
  store.updatedAt = NOW.toISOString();

  fs.writeFileSync(ARTICLES, JSON.stringify(store, null, 1) + '\n');
  fs.writeFileSync(SPARES, JSON.stringify(spares, null, 1) + '\n');

  const costOf = w => (use[w].in * PRICE[w].in + use[w].out * PRICE[w].out) / 1e6;
  const summary = [
    `## 虚構ニュース 生成結果`,
    `- 新しく入れた記事: ${added}本（うち予備記事 ${usedSpare}本、絵つき ${images}本）`,
    `- 空きのままの枠: ${empty}本`,
    `- 予備記事の残り: ${spares.spares.length}本`,
    ...(stopped ? ['- AIが呼べなかったので、残りの枠は作らずに止めました（次の実行で作ります）'] : []),
    `- AIの呼び出し: ${calls}回（上限 ${MAX_CALLS}回）`,
    `- 文章とチェック Gemini（${GEMINI_MODEL}）: ${use.gemini.calls}回、入力 ${use.gemini.in} / 出力 ${use.gemini.out} トークン、目安 $${costOf('gemini').toFixed(4)}`,
    `- 絵 OpenAI（${IMAGE_MODEL}・${IMAGE_QUALITY}）: ${use.openai.calls}回、入力 ${use.openai.in} / 出力 ${use.openai.out} トークン、目安 $${costOf('openai').toFixed(4)}`,
  ].join('\n');
  log('\n' + summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}

main().catch(e => { console.error(e.message); process.exit(1); });
