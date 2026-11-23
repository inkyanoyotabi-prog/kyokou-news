// 虚構ニュース：翌日分の記事をAIに書かせる
// 二重に書かせない作り：記事IDは「日付_時刻」で決まる。すでにあるIDは作らない。
// 呼び出し回数の上限（MAX_CALLS）を超えたら、その場で止める。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ARTICLES = path.join(ROOT, 'docs', 'articles.json');
const SPARES = path.join(ROOT, 'yobi.json');
const EVENTS = path.join(ROOT, 'tokubetsu.json'); // 特別な日（夜旅さんが自由に足せる）

const SLOTS = ['07:00', '12:00', '15:00', '18:00', '21:00'];
const KEEP_DAYS = 30;
const SPARE_TARGET = 3;
const EVENT_SLOTS = ['07:00', '18:00']; // 特別な日は、この2本をその日にちなんだ記事にする

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = Number(process.env.LIMIT || 0);          // 試しに少しだけ作るとき（1なら1本だけ）
const MAX_CALLS = Number(process.env.MAX_CALLS || 40); // 1回の実行で呼べる上限（2社の合計）
// 100万トークンあたりのドル（目安の料金の計算用）
const PRICE = {
  gemini: { in: Number(process.env.GEMINI_IN_PRICE || 0.75), out: Number(process.env.GEMINI_OUT_PRICE || 3.75) },
  openai: { in: Number(process.env.OPENAI_IN_PRICE || 0.25), out: Number(process.env.OPENAI_OUT_PRICE || 2.00) },
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

function countCall(who) {
  if (calls >= MAX_CALLS) throw new Error(`呼び出し上限（${MAX_CALLS}回）に達したので止めました`);
  calls++; use[who].calls++;
}

// 見出し係（OpenAI）
async function callOpenAI(prompt) {
  if (DRY_RUN) { countCall('openai'); return fakeAI('openai', prompt); }
  const data = await post('openai', 'https://api.openai.com/v1/chat/completions',
    { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
    {
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      reasoning_effort: process.env.OPENAI_REASONING || 'low', // 見出しは短いので考えすぎさせない（料金のため）
    });
  use.openai.in += data.usage?.prompt_tokens || 0;
  use.openai.out += data.usage?.completion_tokens || 0;
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}

// 本文係・チェック係（Gemini）
async function callGemini(prompt) {
  if (DRY_RUN) { countCall('gemini'); return fakeAI('gemini', prompt); }
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

// 試運転用の偽AI（DRY_RUN=1 のときだけ）
let fakeN = 0;
function fakeAI(who, prompt) {
  if (prompt.startsWith('#CHECK')) return { ok: !prompt.includes('地震'), reason: '' };
  if (who === 'openai') {
    fakeN++;
    const bad = process.env.FAKE_BAD && fakeN <= Number(process.env.FAKE_BAD);
    return { category: '地域', headline: bad ? `地震で町が揺れる（テスト${fakeN}）` : `ねこ町議会、昼寝を公務と認定（テスト${fakeN}）` };
  }
  return {
    body: 'ねこ町議会は二十三日、昼寝を正式な公務と認める条例案を全会一致で可決した。\n\n町によると、議員の八割が会議中に眠っていたことから「実態に合わせた」という。\n\n来年度からは昼寝手当も支給される見通し。町長は「起きている議員の方が少数派だった。民意を反映した」と胸を張った。一方、町内の枕店には注文が殺到しているという。',
  };
}

const RULES = `## 絶対に守ること
- 人名・地名・会社名・団体名・商品名は、すべて実在しない架空のものにする（例：もぐら市、株式会社ほたて工業）。実在の国名・都道府県名・市町村名・有名人・政治家・企業・ブランド・作品名は使わない。
- 次の話題は書かない：選挙・政党・政治家、災害、事故、死亡、病気、犯罪・逮捕、戦争・テロ、宗教、民族・国籍・性別・障害などへの差別や揶揄、性的な内容、実在の報道機関のまね。
- 特定の誰かを傷つけたり、本当のニュースと勘違いされたりする内容にしない。`;

function eventNote(ev) {
  return ev ? `\n## 今日は「${ev}」\nこの日にちなんだ、くだらない話題にする。行事の楽しい面だけを扱い、宗教や歴史上の悲しい出来事には触れない。\n` : '';
}

function headlinePrompt(recent, ev) {
  return `あなたは架空のニュースサイトのデスクです。日本語の「虚構ニュース」の見出しを1本考えてください。
${eventNote(ev)}
## 見出しの書き方
- 本物の新聞の見出しのような、まじめで簡潔な言い回し。内容はばかばかしく、見出しだけで笑えるもの。
- 28文字以内。

${RULES}

## 最近の見出し（同じ話題・同じ型をくり返さない）
${recent.map(h => '- ' + h).join('\n') || '- （まだなし）'}

## 出力
次のJSONだけを返す：
{"category": "${CATEGORIES.join('|')}のどれか", "headline": "見出し"}`;
}

function bodyPrompt(h, ev) {
  return `あなたは架空のニュースサイトの記者です。次の見出しの「虚構ニュース」の本文を書いてください。

見出し：${h.headline}
分野：${h.category}
${eventNote(ev)}
## 本文の書き方
- 本物の新聞のような、まじめで落ち着いた文体。見出しの内容を、もっともらしい細部でふくらませて笑わせる。
- 250〜450文字。3〜4段落。段落の間は空行（\\n\\n）。
- 見出しは書かない。本文だけ。
- 「フィクション」「架空」「ジョーク」などの断り書きは書かない。

${RULES}

## 出力
次のJSONだけを返す：
{"body": "本文"}`;
}

function checkPrompt(a) {
  return `#CHECK
次の架空ニュース記事が、下の条件をすべて守っているか判定してください。

条件：
1. 実在の人物・国・都道府県・市町村・企業・団体・商品・作品の名前が出てこない。
2. 選挙・政治家、災害、事故、死亡、病気、犯罪、戦争・テロ、宗教、差別、性的な内容を扱っていない。
3. 本物のニュースと勘違いされるような、もっともらしい嘘になっていない（ばかばかしさで冗談だとわかる）。
4. 誰かを傷つける・揶揄する内容ではない。
5. 本文が見出しの内容に合っている。
（七夕・クリスマスなどの年中行事を楽しい話題として扱うのは問題ない）

記事：
見出し：${a.headline}
本文：${a.body}

次のJSONだけを返す：{"ok": true または false, "reason": "falseのときの理由（短く）"}`;
}

async function makeOne(recent, ev) {
  for (let attempt = 1; attempt <= 2; attempt++) { // やり直しは1回まで
    // 1. 見出し（OpenAI）
    const h = await callOpenAI(headlinePrompt(recent, ev));
    if (!h || typeof h.headline !== 'string' || !h.headline.trim() || h.headline.length > 40) { log(`  見出しの形がおかしいので不採用（${attempt}回目）`); continue; }
    h.headline = h.headline.trim();
    if (!CATEGORIES.includes(h.category)) h.category = '社会';
    if (NG.test(h.headline)) { log(`  見出しに禁止語（${attempt}回目）: ${h.headline}`); continue; }
    // 2. 本文（Gemini）
    const b = await callGemini(bodyPrompt(h, ev));
    const body = typeof b?.body === 'string' ? b.body.trim() : '';
    if (body.length < 100 || body.length > 900) { log(`  本文の形がおかしいので不採用（${attempt}回目）: ${h.headline}`); continue; }
    if (NG.test(body)) { log(`  本文に禁止語（${attempt}回目）: ${h.headline}`); continue; }
    // 3. チェック（Gemini）
    const a = { category: h.category, headline: h.headline, body };
    const c = await callGemini(checkPrompt(a));
    if (!c || c.ok !== true) { log(`  チェックで不採用（${attempt}回目）: ${h.headline} / ${c?.reason || ''}`); continue; }
    return a;
  }
  return null;
}

// お金のかからない確認：使うモデルが本当に使えるかを、記事を書かせる前に確かめる
async function preflight() {
  const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`, { headers: { 'x-goog-api-key': GEMINI_KEY } });
  if (!g.ok) throw new Error(`Geminiのモデル ${GEMINI_MODEL} が使えません（${g.status}）。何も書かせずに止めました`);
  const o = await fetch(`https://api.openai.com/v1/models/${OPENAI_MODEL}`, { headers: { authorization: `Bearer ${OPENAI_KEY}` } });
  if (!o.ok) throw new Error(`OpenAIのモデル ${OPENAI_MODEL} が使えません（${o.status}）。何も書かせずに止めました`);
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
  let added = 0, usedSpare = 0, empty = 0;

  for (const n of need) {
    if (have.has(n.id)) continue; // 念のため送る直前にもう一度確かめる
    log(`[${n.id}]`);
    let a = null;
    const ev = EVENT_SLOTS.includes(n.slot) ? events[n.date.slice(5)] : null;
    if (ev) log(`  特別な日: ${ev}`);
    try { a = await makeOne(recent, ev); } catch (e) { log('  ' + e.message); if (calls >= MAX_CALLS) break; }
    if (!a && spares.spares.length) { a = spares.spares.shift(); usedSpare++; log('  予備記事を使いました'); }
    if (!a) { empty++; log('  この枠は空きのままです'); continue; }
    const art = { id: n.id, publishAt: `${n.date}T${n.slot}:00+09:00`, category: a.category, headline: a.headline, body: a.body };
    store.articles.push(art);
    have.add(n.id);
    added++;
    recent.push(art.headline);
    log(`  → ${art.headline}`);
  }

  // 予備記事を補充（試しの実行では作らない）
  if (LIMIT === 0) {
    while (spares.spares.length < SPARE_TARGET && calls + 6 <= MAX_CALLS) {
      log('[予備]');
      const a = await makeOne(recent).catch(e => { log('  ' + e.message); return null; });
      if (!a) break;
      spares.spares.push(a); recent.push(a.headline);
      log(`  → ${a.headline}`);
    }
  }

  // 古い記事を片づける
  const cutoff = NOW.getTime() - KEEP_DAYS * 864e5;
  store.articles = store.articles
    .filter(a => new Date(a.publishAt).getTime() >= cutoff)
    .sort((x, y) => x.publishAt.localeCompare(y.publishAt));
  store.updatedAt = NOW.toISOString();

  fs.writeFileSync(ARTICLES, JSON.stringify(store, null, 1) + '\n');
  fs.writeFileSync(SPARES, JSON.stringify(spares, null, 1) + '\n');

  const costOf = w => (use[w].in * PRICE[w].in + use[w].out * PRICE[w].out) / 1e6;
  const summary = [
    `## 虚構ニュース 生成結果`,
    `- 新しく入れた記事: ${added}本（うち予備記事 ${usedSpare}本）`,
    `- 空きのままの枠: ${empty}本`,
    `- 予備記事の残り: ${spares.spares.length}本`,
    `- AIの呼び出し: ${calls}回（上限 ${MAX_CALLS}回）`,
    `- 見出し OpenAI（${OPENAI_MODEL}）: ${use.openai.calls}回、入力 ${use.openai.in} / 出力 ${use.openai.out} トークン、目安 $${costOf('openai').toFixed(4)}`,
    `- 本文とチェック Gemini（${GEMINI_MODEL}）: ${use.gemini.calls}回、入力 ${use.gemini.in} / 出力 ${use.gemini.out} トークン、目安 $${costOf('gemini').toFixed(4)}`,
  ].join('\n');
  log('\n' + summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}

main().catch(e => { console.error(e.message); process.exit(1); });
