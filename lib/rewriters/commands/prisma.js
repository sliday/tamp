// Targets:
//   prisma generate / prisma migrate / prisma db push
//   npx prisma generate
//
// Strips: "Environment variables loaded from .env", "Prisma schema loaded
// from prisma/schema.prisma", spinner frames with "✔" replaced characters,
// braille spinner lines. Keeps: "Generated Prisma Client" success line,
// error blocks, migration summaries, query engine paths.

const ENV_LINE = /^Environment variables loaded from\s+\S+\s*$/;
const SCHEMA_LINE = /^Prisma schema loaded from\s+\S+\s*$/;
const DATASOURCE_LINE = /^Datasource "\w+":\s/;
const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+/;
const PRISMA_SIG = /(^|\n)(Prisma schema loaded from|Environment variables loaded from|Generated Prisma Client|Running generate|✔ Generated)/;

export default {
  name: 'prisma',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return PRISMA_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const out = [];

    for (const line of lines) {
      if (ENV_LINE.test(line)) continue;
      if (SCHEMA_LINE.test(line)) continue;
      if (DATASOURCE_LINE.test(line)) continue;
      if (SPINNER.test(line)) continue;
      out.push(line);
    }

    const collapsed = [];
    let blank = 0;
    for (const l of out) {
      if (l.trim() === '') {
        blank++;
        if (blank > 1) continue;
      } else {
        blank = 0;
      }
      collapsed.push(l);
    }
    return collapsed.join('\n');
  },
};
