// Daily homework agent: Mashov (Shalev) + Webtop (Noam) -> Claude summary -> WhatsApp (CallMeBot).
import Anthropic from '@anthropic-ai/sdk';
import { WebtopMobileClient } from 'webtop-api-client';

const TZ = 'Asia/Jerusalem';
const DRY_RUN = process.env.DRY_RUN === '1';

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// YYYY-MM-DD in Israel time, shifted by `days`.
function israelDate(days = 0) {
  const d = new Date(Date.now() + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

// GitHub cron runs in UTC, so the workflow fires at both 12:30 and 13:30 UTC.
// Only the run that lands on 15:30 Israel time (summer UTC+3 / winter UTC+2) proceeds.
function shouldRunNow() {
  const schedule = process.env.SCHEDULE;
  if (!schedule) return true; // manual run
  const israelHour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()),
  );
  const utcHour = new Date().getUTCHours();
  const offset = (israelHour - utcHour + 24) % 24;
  const expected = offset === 3 ? '30 12' : '30 13';
  return schedule.startsWith(expected);
}

// ---------- Mashov ----------
async function fetchMashov() {
  const now = new Date();
  // Mashov names the school year by the year it ends in (2026-27 -> 2027).
  const year = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
  const version = '3.20210425';

  const loginRes = await fetch('https://web.mashov.info/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      semel: Number(env('MASHOV_SCHOOL_ID')),
      year,
      username: env('MASHOV_USERNAME'),
      password: env('MASHOV_PASSWORD'),
      IsBiometric: false,
      appName: 'info.mashov.students',
      apiVersion: version,
      appVersion: version,
      appBuild: version,
      deviceUuid: 'chrome',
      devicePlatform: 'chrome',
      deviceManufacturer: 'win',
      deviceModel: 'desktop',
      deviceVersion: '120.0.0.0',
    }),
  });
  if (!loginRes.ok) throw new Error(`Mashov login failed (HTTP ${loginRes.status})`);

  const csrf = loginRes.headers.get('x-csrf-token');
  const cookie = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const login = await loginRes.json();
  // Parent accounts list children; student accounts use their own id.
  const studentId = login.accessToken?.children?.[0]?.childGuid ?? login.credential?.userId;
  if (!studentId) throw new Error('Mashov login succeeded but no student id was returned');

  const hwRes = await fetch(`https://web.mashov.info/api/students/${studentId}/homework`, {
    headers: { 'x-csrf-token': csrf, cookie },
  });
  if (!hwRes.ok) throw new Error(`Mashov homework request failed (HTTP ${hwRes.status})`);
  const homework = await hwRes.json();

  // The endpoint returns the whole year; keep the last few days.
  const since = israelDate(-3);
  return homework
    .filter((h) => !h.lessonDate || h.lessonDate.slice(0, 10) >= since)
    .map(({ lessonDate, subjectName, homework: text, remark }) => ({ lessonDate, subjectName, homework: text, remark }));
}

// ---------- Webtop ----------
async function fetchWebtop() {
  const client = new WebtopMobileClient(env('WEBTOP_USERNAME'), env('WEBTOP_PASSWORD'));
  const result = await client.login();
  if (!result.success) throw new Error(`Webtop login failed: ${result.error ?? 'unknown error'}`);
  try {
    let homework = await client.getHomeworkByDate(israelDate(-3), israelDate(7));
    if (!homework?.length) homework = await client.getHomework();
    return homework ?? [];
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---------- Summary ----------
async function summarize(data) {
  const anthropic = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
  const today = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, dateStyle: 'full' }).format(new Date());

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: `היום ${today}. להלן נתוני שיעורי בית גולמיים (JSON) של שני ילדים, כפי שהתקבלו ממערכות בית הספר.

כתוב/י הודעת וואטסאפ קצרה בעברית להורה:
- כותרת אחת עם התאריך.
- סעיף נפרד לכל ילד (שלו, נועם), ובו רשימה לפי מקצוע: מה צריך להכין ולמתי.
- התמקד/י בשיעורי בית שניתנו היום או שמועד ההגשה שלהם מהיום והלאה. אל תכלול/י משימות ישנות שכבר עבר מועדן.
- אם לילד אין שיעורי בית רלוונטיים, כתוב/י זאת בשורה אחת.
- אם יש שדה error לילד, כתוב/י שלא הצלחנו למשוך את הנתונים שלו היום.
- בלי markdown מלבד *הדגשה* בסגנון וואטסאפ. עד 1200 תווים.

${JSON.stringify(data, null, 1)}`,
      },
    ],
  });
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ---------- WhatsApp (CallMeBot) ----------
async function sendWhatsApp(text) {
  const phone = env('WHATSAPP_PHONE');
  const apikey = env('CALLMEBOT_API_KEY');
  // Keep each request comfortably under URL length limits.
  const chunks = [];
  for (let rest = text; rest.length; ) {
    let cut = rest.length <= 1000 ? rest.length : rest.lastIndexOf('\n', 1000);
    if (cut <= 0) cut = 1000;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  for (const chunk of chunks) {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(chunk)}&apikey=${encodeURIComponent(apikey)}`;
    const res = await fetch(url);
    const body = await res.text();
    if (!res.ok || /error/i.test(body.slice(0, 300))) {
      throw new Error(`CallMeBot failed (HTTP ${res.status}): ${body.replace(/<[^>]+>/g, ' ').slice(0, 300)}`);
    }
  }
}

async function main() {
  if (!shouldRunNow()) {
    console.log('Not 15:30 in Israel for this cron slot, skipping.');
    return;
  }

  const sources = { 'שלו (משו"ב)': fetchMashov, 'נועם (וובטופ)': fetchWebtop };
  const data = {};
  for (const [child, fetcher] of Object.entries(sources)) {
    try {
      data[child] = await fetcher();
      console.log(`${child}: ${data[child].length} items`);
    } catch (err) {
      console.error(`${child}: ${err.message}`);
      data[child] = { error: err.message };
    }
  }

  const message = await summarize(data);
  console.log('\n----- message -----\n' + message + '\n-------------------');

  if (DRY_RUN) {
    console.log('DRY_RUN=1, not sending.');
    return;
  }
  await sendWhatsApp(message);
  console.log('Sent to WhatsApp.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
