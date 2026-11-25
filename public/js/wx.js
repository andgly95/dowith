// Weather, in words and a mark. The server sends numbers (lib/weather.js) in
// Celsius and WMO codes; how they read is decided here, on the phone — which
// is also where Fahrenheit is decided, by the phone's own region.

const CODES = [
  [[0], 'Clear', '☀️', '🌙'],
  [[1], 'Mostly clear', '🌤️', '🌙'],
  [[2], 'Partly cloudy', '⛅', '☁️'],
  [[3], 'Cloudy', '☁️', '☁️'],
  [[45, 48], 'Fog', '🌫️', '🌫️'],
  [[51, 53, 55], 'Drizzle', '🌦️', '🌧️'],
  [[56, 57], 'Freezing drizzle', '🌧️', '🌧️'],
  [[61], 'Light rain', '🌧️', '🌧️'],
  [[63], 'Rain', '🌧️', '🌧️'],
  [[65], 'Heavy rain', '🌧️', '🌧️'],
  [[66, 67], 'Freezing rain', '🌧️', '🌧️'],
  [[71, 73, 75, 77], 'Snow', '🌨️', '🌨️'],
  [[80, 81], 'Showers', '🌦️', '🌧️'],
  [[82], 'Heavy showers', '🌧️', '🌧️'],
  [[85, 86], 'Snow showers', '🌨️', '🌨️'],
  [[95, 96, 99], 'Thunderstorms', '⛈️', '⛈️'],
];

export function wxOf(code, day = true) {
  const row = CODES.find(r => r[0].includes(code));
  return row ? { label: row[1], icon: day ? row[2] : row[3] } : { label: '', icon: '🌡️' };
}

// The US and the two other places that still use it.
const F = /-(US|LR|MM)\b/i.test((navigator.languages && navigator.languages[0]) || navigator.language || '');
export const deg = (c) => (Number.isFinite(c) ? `${Math.round(F ? (c * 9) / 5 + 32 : c)}°` : '–');

// "15:00" → "3 PM".
export function hourWords(t) {
  const [h, m] = String(t || '').split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}
