// Builds docs/assets/demo.svg, the terminal demo in the README, from scripts/demo/transcript.txt.
// Run it again after you change the transcript: node scripts/demo/svg.ts
//
// Each line of the transcript starts with a mark and one space:
//   >  an agent's tool call, typed      $  a shell command, typed ($ alone: the last prompt)
//   -  plain output                     !  red: a block
//   ^  bold: a heading                  ~  dim
//   +  first word green ("done")        *  first word yellow ("next")
// An empty line is an empty row and a pause.
//
// The lines appear one by one with CSS animations. With reduced motion, the last frame shows.
import { readFileSync, writeFileSync } from 'node:fs';

const TRANSCRIPT_URL = new URL('transcript.txt', import.meta.url);
const OUTPUT_URL = new URL('../../docs/assets/demo.svg', import.meta.url);
const TITLE = 'An agent runs git push --force. yokoten blocks it and says what happened, why, and the fix. Then yokoten doctor names the next step.';

const FONT_SIZE = 13;
const LINE_HEIGHT = 20;
const CHAR_WIDTH = 7.9;
const PADDING = 20;
const BAR_HEIGHT = 34;
const PROMPT = '~/my-app $ ';
const AGENT_LABEL = 'agent > ';

const START_DELAY = 0.6;
const SECONDS_PER_CHAR = 0.045;
const PAUSE_AFTER_TYPING = 0.5;
const SECONDS_PER_LINE = 0.12;
const PAUSE_AT_BLANK = 1;

type Line = { mark: string; text: string };

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readTranscript(): Line[] {
  const source = readFileSync(TRANSCRIPT_URL, 'utf8').replace(/\n+$/, '');
  return source.split('\n').map((raw) => ({ mark: raw.slice(0, 1), text: raw.slice(2) }));
}

function formatSeconds(seconds: number): string {
  return `${Number(seconds.toFixed(2))}s`;
}

// The typed part of a line: one tspan per character, each shown a little later.
function typeCharacters(text: string, startAt: number): string {
  return [...text]
    .map((character, index) => `<tspan class="c" style="animation-delay:${formatSeconds(startAt + index * SECONDS_PER_CHAR)}">${escapeXml(character)}</tspan>`)
    .join('');
}

function colorFirstWord(text: string, className: string): string {
  const match = /^(\s*)(\S+)(.*)$/.exec(text);
  if (!match) return escapeXml(text);
  return `${escapeXml(match[1])}<tspan class="${className}">${escapeXml(match[2])}</tspan>${escapeXml(match[3])}`;
}

function buildRows(lines: Line[]): { rows: string[]; columns: number } {
  const rows: string[] = [];
  let time = START_DELAY;
  let columns = 0;
  lines.forEach((line, index) => {
    const y = BAR_HEIGHT + PADDING + index * LINE_HEIGHT + FONT_SIZE;
    const open = (className: string) => `<text x="${PADDING}" y="${y}" class="${`l ${className}`.trim()}" style="animation-delay:${formatSeconds(time)}">`;
    if (line.mark === '' && line.text === '') {
      time += PAUSE_AT_BLANK;
      return;
    }
    if (line.mark === '>' || line.mark === '$') {
      const label = line.mark === '>' ? `<tspan class="a">${escapeXml(AGENT_LABEL)}</tspan>` : `<tspan class="p">${escapeXml(PROMPT)}</tspan>`;
      const labelLength = line.mark === '>' ? AGENT_LABEL.length : PROMPT.length;
      columns = Math.max(columns, labelLength + line.text.length + 1);
      if (line.text === '') {
        rows.push(`${open('')}${label}<tspan class="k">█</tspan></text>`);
        return;
      }
      rows.push(`${open('')}${label}${typeCharacters(line.text, time + 0.3)}</text>`);
      time += 0.3 + line.text.length * SECONDS_PER_CHAR + PAUSE_AFTER_TYPING;
      return;
    }
    columns = Math.max(columns, line.text.length);
    const body =
      line.mark === '+' ? colorFirstWord(line.text, 'g') : line.mark === '*' ? colorFirstWord(line.text, 'y') : escapeXml(line.text);
    const className = { '!': 'r', '^': 'b', '~': 'd' }[line.mark] ?? '';
    rows.push(`${open(className)}${body}</text>`);
    time += SECONDS_PER_LINE;
  });
  return { rows, columns };
}

function buildSvg(lines: Line[]): string {
  const { rows, columns } = buildRows(lines);
  const width = Math.ceil(PADDING * 2 + columns * CHAR_WIDTH);
  const height = BAR_HEIGHT + PADDING * 2 + lines.length * LINE_HEIGHT;
  const style = [
    'text{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;fill:#e6edf3;white-space:pre}',
    '.l{animation:show .01s both}',
    '.c{animation:type .01s both}',
    '.k{animation:blink 1s step-end infinite}',
    '.a{fill:#ec8f6c}.p{fill:#7ee787}.r{fill:#ff7b72;font-weight:bold}.b{font-weight:bold}.d,.t{fill:#9198a1}.g{fill:#7ee787}.y{fill:#e3b341}',
    '@keyframes show{from{opacity:0}to{opacity:1}}',
    '@keyframes type{from{fill-opacity:0}to{fill-opacity:1}}',
    '@keyframes blink{50%{fill-opacity:0}}',
    '@media (prefers-reduced-motion:reduce){.l,.c,.k{animation:none}}',
  ].join('\n');
  const dots = ['#ff5f57', '#febc2e', '#28c840'].map((color, index) => `<circle cx="${PADDING + index * 18}" cy="${BAR_HEIGHT / 2}" r="5.5" fill="${color}"/>`).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title" xml:space="preserve">`,
    `<title id="title">${escapeXml(TITLE)}</title>`,
    `<style>\n${style}\n</style>`,
    `<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>`,
    `<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="9.5" fill="none" stroke="#3d444d"/>`,
    `<path d="M0 ${BAR_HEIGHT}H${width}" stroke="#3d444d"/>`,
    dots,
    `<text x="${width / 2}" y="${BAR_HEIGHT / 2 + 4}" text-anchor="middle" class="t">my-app</text>`,
    ...rows,
    '</svg>',
    '',
  ].join('\n');
}

writeFileSync(OUTPUT_URL, buildSvg(readTranscript()));
console.log(`wrote ${OUTPUT_URL.pathname.split('/').slice(-3).join('/')}`);
