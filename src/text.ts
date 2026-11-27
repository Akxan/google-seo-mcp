// Language helpers shared by the GSC, crawl and GEO tools. Pure, no I/O.

// Words that open a question in the space-separated languages the managed sites use (en, es, ca, fr, de,
// it, pt, ru, uk, ar, he). Matched at the start, followed by a space, punctuation or the end: JavaScript's
// \b treats accented letters as non-word characters, so `qué\b` never matched "qué ver" and `où\b` never
// matched "où manger".
const LEADING_QUESTION_WORDS = [
  // English
  "how", "what", "why", "when", "where", "which", "who", "whose", "is", "are", "can", "could", "does", "do", "did", "should", "would", "will", "best", "top",
  // Spanish
  "cómo", "como", "qué", "que", "por qué", "porque", "cuándo", "cuando", "dónde", "donde", "adónde", "cuál", "cual", "cuáles", "quién", "quien", "cuánto", "cuanto", "cuánta", "cuántos", "cuántas", "mejor", "mejores", "vale la pena", "se puede", "es", "son", "puedo", "hay",
  // Catalan ("on" = where is left out: it collides with English queries such as "on page seo")
  "com", "què", "per què", "quan", "quin", "quina", "quins", "quines", "qui", "quant", "quanta", "val la pena", "es pot",
  // French
  "comment", "quoi", "qu'est-ce", "qu’est-ce", "pourquoi", "quand", "où", "quel", "quelle", "quels", "quelles", "combien", "est-ce", "peut-on", "faut-il",
  // German
  "wie", "was", "warum", "wann", "wo", "woher", "wohin", "welche", "welcher", "welches", "wer", "wieviel", "wie viel", "kann", "ist", "sind", "lohnt sich", "gibt es",
  // Italian
  "come", "cosa", "che cosa", "perché", "quando", "dove", "quale", "quali", "chi", "quanto", "quanta", "quanti", "conviene", "si può",
  // Portuguese
  "o que", "por que", "onde", "qual", "quais", "quem", "quantos", "vale a pena", "pode",
  // Russian
  "как", "что", "почему", "зачем", "когда", "где", "куда", "какой", "какая", "какие", "какое", "кто", "сколько", "можно", "стоит ли",
  // Ukrainian
  "як", "що", "чому", "навіщо", "коли", "де", "який", "яка", "які", "яке", "хто", "скільки", "чи",
  // Arabic
  "كيف", "ما", "ماذا", "لماذا", "متى", "أين", "اين", "أي", "من", "كم", "هل",
  // Hebrew
  "איך", "מה", "למה", "מדוע", "מתי", "איפה", "היכן", "איזה", "איזו", "אילו", "מי", "כמה", "האם",
];
const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LEADING = new RegExp(`^(?:${[...LEADING_QUESTION_WORDS].sort((a, b) => b.length - a.length).map(escape).join("|")})(?=$|[\\s,.:;!?¿¡"'’«»()-])`, "iu");

// Chinese, Japanese and Korean put the question word anywhere, without spaces. Bare 何 is left out on
// purpose: it also starts transliterated names (何塞 = José).
const CJK_QUESTION = /怎么|怎麼|怎样|怎樣|如何|为什么|為什麼|为何|為何|什么|什麼|哪里|哪裡|哪儿|哪个|哪個|哪些|多少|多久|是否|能否|谁|誰|(?:吗|嗎|呢)[?？]?\s*$|どう|なぜ|なに|いつ|どこ|どれ|どの|いくら|いくつ|ですか|ますか|어떻게|무엇|뭐|왜|언제|어디|누구|얼마|몇|어느|(?:까|나요|가요)[?？]?\s*$/u;

/** True when a heading or search query is phrased as a question, in any of the supported languages. */
export function isQuestion(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return /[?？؟]\s*$/u.test(t) || /^[¿؟]/u.test(t) || LEADING.test(t) || CJK_QUESTION.test(t);
}

// Short function words dropped before comparing texts. Words of 1–2 letters are dropped anyway.
export const STOP_WORDS = new Set(("the and for are with from was were will can not you your our they their this that these those its into over than then also very " +
  "del los las una para con por que una uno sus como más pero sin sobre entre hasta desde este esta estos estas ese esa eso muy son fue han hay está están " +
  "els les amb per però com més una dels als " +
  "der die das und mit von für ist sind ein eine einen dem den des auf aus bei nicht auch wie wir sie ihr " +
  "les des une est sont avec pour par dans sur pas plus que qui aux ces ses " +
  "che con per non una uno gli della delle degli nel nella sono come più " +
  "uma com para por não dos das nos nas mais como são " +
  "это как что для или так все при без над под " +
  "що для або при без над під " +
  "את של על עם זה זו גם אבל או כי " +
  "على في من إلى عن مع هذا هذه التي الذي أو لا").split(" "));

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Lower-cased content words. Chinese and Japanese have no spaces between words, so runs of those scripts
    become character bigrams; otherwise a whole heading would be one "word" and never overlap with anything. */
export function contentWords(s: string): string[] {
  const out: string[] = [];
  for (const w of s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)) {
    if (!w) continue;
    if (!HAS_CJK.test(w)) { if (w.length > 2 && !STOP_WORDS.has(w)) out.push(w); continue; }
    for (const run of w.split(CJK_RUN)) if (run.length > 2 && !STOP_WORDS.has(run)) out.push(run);
    for (const run of w.match(CJK_RUN) ?? []) {
      if (run.length === 1) continue;
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

let segmenter: Intl.Segmenter | null | undefined;
function wordSegments(text: string): string[] | null {
  if (segmenter === undefined) { try { segmenter = new Intl.Segmenter(undefined, { granularity: "word" }); } catch { segmenter = null; } }
  if (!segmenter) return null;
  const out: string[] = [];
  for (const s of segmenter.segment(text)) if (s.isWordLike) out.push(s.segment);
  return out;
}

/** Word count that also works for Chinese and Japanese, which do not separate words with spaces
    (counting spaces made a 2,000-character Chinese article "40 words" and flagged it as thin). */
export function countWords(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  if (!HAS_CJK.test(t)) return t.split(/\s+/).length;
  const seg = wordSegments(t);
  if (seg) return seg.length;
  const cjk = (t.match(CJK_RUN) ?? []).join("").length;
  return Math.round(cjk / 1.6) + t.replace(CJK_RUN, " ").split(/\s+/).filter(Boolean).length;
}

/** The first n words of a text, keeping the original spacing and punctuation. */
export function firstWords(text: string, n: number): string {
  const t = text.trim();
  if (!HAS_CJK.test(t)) return t.split(/\s+/).slice(0, n).join(" ");
  if (!segmenter && segmenter !== null) wordSegments("");
  if (!segmenter) return t.slice(0, n * 2);
  let words = 0;
  for (const s of segmenter.segment(t)) {
    if (s.isWordLike && ++words > n) return t.slice(0, s.index).trim();
  }
  return t;
}

/** Sentences, splitting after . ! ? followed by a space and after 。！？؟ with or without one
    (Chinese and Japanese put no space after a full stop, so the whole page used to be one sentence). */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|(?<=[。！？؟])\s*/u).map((x) => x.trim()).filter(Boolean);
}

/** Approximate on-screen width: East Asian wide and full-width characters take two columns, which is why
    a 30-character Chinese title already fills the space of a 60-character English one in search results. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(ch) ? 2 : 1;
  return w;
}

/** Interrogative words (and their CJK bigrams) that carry no topic: removed when matching a question to an answer. */
export const QUESTION_TERMS = new Set([
  ...LEADING_QUESTION_WORDS.flatMap((w) => w.toLowerCase().split(/\s+/)),
  "cheapest", "nearest", "cerca",
  "怎么", "怎麼", "怎样", "怎樣", "如何", "为什", "為什", "什么", "什麼", "哪里", "哪裡", "哪个", "哪個", "哪些", "多少", "多久", "是否", "能否",
  "どう", "なぜ", "どこ", "いつ", "어떻게", "무엇", "어디", "언제",
]);
