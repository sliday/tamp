// Targets:
//   terraform plan / terraform apply
//
// Strips: every "<resource>: Refreshing state... [id=...]" line under plan,
// repetitive "Still creating... [Xs elapsed]" progress lines during apply.
// Keeps: the "Plan: N to add, M to change, K to destroy." summary, all
// Warning:/Error: blocks, resource diff output, variable prompts.

const REFRESH_LINE = /^\S[\w.\-\[\]"]*:\s+Refreshing state\.\.\./;
const STILL_LINE = /:\s+Still (creating|destroying|modifying)\.\.\.\s+\[\d+[smh]\s+elapsed\]/;
const READING_LINE = /:\s+Reading\.\.\.\s*$/;
const READ_COMPLETE_LINE = /:\s+Read complete after\s+\d+[smh]/;
const TF_SIG = /(^|\n)(Refreshing state\.\.\.|Terraform will perform the following actions|Plan: \d+ to add|Apply complete!|Terraform used the selected providers|Initializing the backend)/;

export default {
  name: 'terraform',

  match(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return TF_SIG.test(text);
  },

  rewrite(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const out = [];

    for (const line of lines) {
      if (REFRESH_LINE.test(line)) continue;
      if (STILL_LINE.test(line)) continue;
      if (READING_LINE.test(line)) continue;
      if (READ_COMPLETE_LINE.test(line)) continue;
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
