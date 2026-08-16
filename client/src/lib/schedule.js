// Client-side scheduled-message storage (localStorage per user).
// Scheduled messages are sent through the normal E2EE send path when their time
// arrives, so encryption counters always stay monotonic and correct.

export const SCHEDULE_KEY = (userId) => `pulseroom_scheduled_${userId}`;

export function loadSchedules(userId) {
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Failed to load scheduled messages:', err.message);
    return [];
  }
}

export function saveSchedules(userId, items) {
  try {
    localStorage.setItem(SCHEDULE_KEY(userId), JSON.stringify(items));
  } catch (err) {
    console.warn('Failed to save scheduled messages:', err.message);
  }
}

export function makeScheduleId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
