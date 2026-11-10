// Turn a typed or official suburb name into a comparison key, so that
// "mt druitt", "Mount Druitt" and "MOUNT-DRUITT" all match.
export function normalize(s) {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\bmount\b/g, 'mt')
    .replace(/\bsaint\b/g, 'st')
    .replace(/[^a-z0-9]/g, '');
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
