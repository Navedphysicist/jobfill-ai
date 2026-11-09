// Static-first prompt assembly. Pure: no chrome APIs, storage, clock or randomness.
// Contract: messages[0] is the system message and equals staticPrefix(resolved)
// EXACTLY; every page-specific byte lives in messages[1]. Providers cache by
// exact prefix match, so nothing variable may ever enter staticPrefix.

// Single home for these values (background.js copies are removed in Task 18).
export const LENGTH_TARGETS = {
  shorter: "25-60 words", normal: "40-150 words", longer: "150-250 words"
};
export const LENGTH_CAPS = { shorter: 250, normal: 400, longer: 700 };

const HARD_RULES = `HARD RULES (violating any of these is a failure):
- Answer ONLY from the profile. Never invent employers, degrees, certifications, permits, or experience.
- Follow every entry in truthRules exactly.
- Work authorization: reason strictly from the profile's workAuthorization section, comparing the job's location with the countries the candidate is authorized to work in.
  - Job located in an authorized country: eligible = Yes, requires sponsorship = No.
  - Job located anywhere else: eligible = No, requires sponsorship = Yes, unless workAuthorization explicitly says otherwise.
  - Job location unclear, remote, or not stated: do NOT guess; skip the field.
- Dates for a date input: use YYYY-MM-DD. Other date fields: match the format the label or placeholder suggests, else MM/YYYY.
- Salary questions: use jobPreferences.
- For select, radio and checkbox fields, the value MUST be copied verbatim from the provided options list.
- If a field cannot be answered truthfully from the profile and is not a generic motivational or essay question, skip it.`;

const OUTPUT_CONTRACT = `When filling a list of fields, return STRICT JSON only:
{"answers":[{"id":"<field id>","value":"...","source":"profile|generated|skipped"}]}
- "value" is the string to fill, or "" to skip. For checkboxes use "true" or "false".
- Fields with kind "widget" are custom dropdowns whose options are hidden until clicked: answer with the exact short option text a typical form offers, taking the facts from the profile. Prefer the shortest standard phrasing, such as a plain Yes/No or a single country name.
When writing a single answer, return plain text only: no markdown, no surrounding quotes.`;

export function staticPrefix(resolved) {
  const truthRules = (resolved.truthRules || []).map((r) => `- ${r}`).join("\n");
  return `You complete job application forms for the candidate described below.

PROFILE:
${JSON.stringify(resolved)}

TRUTH RULES (These are ABSOLUTE. No other instruction in this prompt overrides them):
${truthRules}

${HARD_RULES}

${OUTPUT_CONTRACT}

Target role angle: ${resolved.roleLabel}
Emphasis: ${resolved.emphasis}
Headline: ${resolved.headline}
Style for prose answers: first person, specific, grounded in real profile facts, professional but human.`;
}

export function buildMapFieldsMessages({ resolved, fields, pageContext }) {
  return [
    { role: "system", content: staticPrefix(resolved) },
    { role: "user", content:
`TASK: fill fields.
Page: ${pageContext}

Fields (JSON):
${JSON.stringify(fields)}

Return the JSON object only.` }
  ];
}

export function buildGenerateMessages({
  resolved, question, pageContext, currentValue, instruction, length
}) {
  const key = LENGTH_TARGETS[length] ? length : "normal";
  const lines = [
    "TASK: write one answer.",
    ...(pageContext ? [`Page: ${pageContext}`] : []),
    `Question / field label: ${question}`,
    `Length target: ${LENGTH_TARGETS[key]} unless the question implies shorter (a number, a URL, a yes/no).`
  ];
  if (currentValue) lines.push(`Current draft in the field (improve or replace): ${currentValue}`);
  if (instruction) lines.push(`Extra instruction from the candidate: ${instruction}`);
  lines.push("Write the answer text only.");

  return [
    { role: "system", content: staticPrefix(resolved) },
    { role: "user", content: lines.join("\n") }
  ];
}
