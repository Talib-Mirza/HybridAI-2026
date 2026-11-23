// Guide or explain, from the wording alone, when it leaves no doubt. Routing on Nano costs ~1.5-2 s per
// question, and most requests say plainly what they want: "what does X mean" is a question, "create a
// service account" is a task. Anything less clear-cut returns null and Nano decides (chooseMode).
// Kept strict on purpose: a wrong shortcut sends the user down the wrong path, a missed one costs ~2 s.

// Asks to understand something.
const EXPLAIN =
  /^(?:please\s+)?(?:explain|describe|tour\b|teach me|help me understand|walk me through (?:this|these|the page|what)\b|give me (?:a |an )?(?:quick |short )?(?:tour|overview)|show me around|what(?:'s| is| are| does| do)\b|what am i\b|how does\b|how do (?:these|those|the|this)\b.*\bwork|why (?:is|are|does|do|did|isn't|aren't)\b|tell me (?:about|what)|what's the difference|is there a difference)/i;

// Asks to do something: an action verb up front, optionally after "how do I", "I want to", "take me to"…
const LEAD = String.raw`(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:help me\s+)?(?:(?:i want|i need|i'd like|i would like) to\s+)?(?:how (?:do|can|should) i\s+|how to\s+|let me\s+)?`;
const VERBS = String.raw`create|add|make|delete|remove|enable|disable|turn (?:on|off)|switch (?:on|off)|set ?up|configure|change|edit|update|rename|rotate|generate|grant|give|invite|revoke|deploy|upgrade|download|upload|connect|link|schedule|restart|stop|start|cancel|reset|open|go to|take me to|navigate to|find|locate|view|see|check|manage|register|install|export|import|share|move|copy|assign|attach|limit|increase|raise|lower|request|pay|close`;
const GUIDE = new RegExp(`^${LEAD}(?:${VERBS})\\b`, "i");
const WHERE = /^(?:where (?:is|are|can i|do i|would i|should i)|where's)\b/i;

// Wording that mixes in a question about meaning: let Nano weigh it.
const MIXED_FOR_EXPLAIN = /\b(?:how to|way to|where|should i|do i need|can i)\b/i;
const MIXED_FOR_GUIDE = /\b(?:mean|means|meaning|difference|why|explain|explained|explains)\b|\bwhat (?:is|are|does|do)\b/i;

/** "guide" | "explain" when the wording settles it, else null. */
export function obviousMode(question) {
  const q = String(question || "").trim().replace(/\s+/g, " ");
  if (!q) return null;
  if (EXPLAIN.test(q)) return MIXED_FOR_EXPLAIN.test(q) ? null : "explain";
  if (GUIDE.test(q) || WHERE.test(q)) return MIXED_FOR_GUIDE.test(q) ? null : "guide";
  return null;
}
