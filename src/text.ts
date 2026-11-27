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
