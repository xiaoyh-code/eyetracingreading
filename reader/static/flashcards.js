// Browser-native, dependency-free scheduling for locally saved vocabulary.
const DAY = 24 * 60 * 60 * 1000;
const AGAIN_DELAY = 10 * 60 * 1000;
const INTERVAL_DAYS = [1, 3, 7, 14, 30, 60, 90];
const MAX_DATE = 8.64e15;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function increment(value) {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function isoDate(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  // Require an ISO date or timestamp, rather than Date.parse's ambiguous local formats.
  const text = value.trim();
  const parts = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(text);
  if (!parts) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return null;
  if (hourText !== undefined && (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59)) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function validNow(now) {
  if (typeof now !== 'number' || !Number.isFinite(now) || Math.abs(now) > MAX_DATE) {
    throw new RangeError('Review time must be a valid timestamp in milliseconds.');
  }
  return now;
}

function wordKey(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.word !== 'string') return null;
  const word = item.word.trim().normalize('NFC');
  if (!word || !/[\p{L}\p{N}]/u.test(word) || /[\u0000-\u001f\u007f]/u.test(word)) return null;
  return word.toLowerCase();
}

function uniqueItems(vocabulary) {
  if (!Array.isArray(vocabulary)) return [];
  const seen = new Set();
  return vocabulary.filter(item => {
    const key = wordKey(item);
    if (key === null || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Sanitize stored metadata without changing the original object. */
export function normalizeReview(review) {
  const value = review && typeof review === 'object' && !Array.isArray(review) ? review : {};
  return {
    streak: count(value.streak),
    reviews: count(value.reviews),
    lapses: count(value.lapses),
    due_at: isoDate(value.due_at),
    last_reviewed_at: isoDate(value.last_reviewed_at),
  };
}

/** Return new metadata after a rating. Durations are elapsed time, independent of DST. */
export function reviewCard(review, rating, now = Date.now()) {
  if (rating !== 'again' && rating !== 'remembered') throw new RangeError('Unsupported flashcard rating.');
  validNow(now);
  const previous = normalizeReview(review);
  const remembered = rating === 'remembered';
  const delay = remembered ? INTERVAL_DAYS[Math.min(previous.streak, INTERVAL_DAYS.length - 1)] * DAY : AGAIN_DELAY;
  const dueTime = now + delay;
  if (dueTime > MAX_DATE) throw new RangeError('Scheduled review exceeds the supported date range.');
  return {
    streak: remembered ? increment(previous.streak) : 0,
    reviews: increment(previous.reviews),
    lapses: remembered ? previous.lapses : increment(previous.lapses),
    due_at: new Date(dueTime).toISOString(),
    last_reviewed_at: new Date(now).toISOString(),
  };
}

/** Old saved words without review metadata are immediately due. */
export function isDue(item, now = Date.now()) {
  validNow(now);
  if (wordKey(item) === null) return false;
  const due = normalizeReview(item.review).due_at;
  return due === null || Date.parse(due) <= now;
}

/** Preserve item references; prefer overdue, then new, then upcoming cards. */
export function buildDeck(vocabulary, mode = 'due', now = Date.now()) {
  validNow(now);
  if (mode !== 'due' && mode !== 'all') throw new RangeError('Unsupported flashcard deck mode.');
  return uniqueItems(vocabulary)
    .map((item, index) => {
      const review = normalizeReview(item.review);
      const due = review.due_at === null ? null : Date.parse(review.due_at);
      const saved = isoDate(item.saved_at);
      return { item, index, due, rank: due === null ? 1 : due <= now ? 0 : 2,
        order: due ?? (saved === null ? Infinity : Date.parse(saved)) };
    })
    .filter(card => mode === 'all' || card.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.order - b.order || a.index - b.index)
    .map(card => card.item);
}

/** nextDueAt is the earliest future schedule, even if other cards are already due. */
export function dueSummary(vocabulary, now = Date.now()) {
  validNow(now);
  const items = uniqueItems(vocabulary);
  let due = 0, nextDue = Infinity;
  for (const item of items) {
    const scheduled = normalizeReview(item.review).due_at;
    if (scheduled === null || Date.parse(scheduled) <= now) due += 1;
    else nextDue = Math.min(nextDue, Date.parse(scheduled));
  }
  return { total: items.length, due, nextDueAt: Number.isFinite(nextDue) ? new Date(nextDue).toISOString() : null };
}
