// src/ui/options/render-form.js
const PERSONAL_ORDER = ["fullName", "firstName", "lastName", "email", "phone",
  "dateOfBirth", "gender", "pronouns", "addressLine", "city", "state",
  "country", "pincode"];

const PREF_ORDER = ["noticePeriod", "currentSalary", "expectedSalary",
  "employmentType", "workMode", "willingToRelocate", "totalExperienceYears"];

const BOOLEAN_PATHS = new Set([
  "jobPreferences.willingToRelocate",
  "workAuthorization.requiresSponsorshipOutsideIndia"
]);
const LIST_PATHS = new Set(["workAuthorization.authorizedToWorkIn"]);

const LONG_FIELDS = new Set(["addressLine", "emphasis", "note"]);

function field(path, value) {
  const wrap = document.createElement("label");
  wrap.className = "jfa-field";

  const span = document.createElement("span");
  span.className = "jfa-label";
  span.textContent = path.split(".").pop().replace(/\[(\d+)\]$/, " $1");
  wrap.appendChild(span);

  const leaf = path.split(".").pop();
  if (BOOLEAN_PATHS.has(path)) {
    const sel = document.createElement("select");
    for (const [v, t] of [["true", "Yes"], ["false", "No"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      sel.appendChild(o);
    }
    sel.value = value === true || value === "true" ? "true" : "false";
    sel.dataset.path = path;
    sel.setAttribute("data-jobfill-ui", "1");
    wrap.appendChild(sel);
    return wrap;
  }
  const long = LONG_FIELDS.has(leaf) || String(value ?? "").length > 90;
  const input = document.createElement(long ? "textarea" : "input");
  if (!long) input.type = "text";
  input.value = value === undefined || value === null ? "" : String(value);
  input.dataset.path = path;
  input.setAttribute("data-jobfill-ui", "1");
  wrap.appendChild(input);

  return wrap;
}

function section(title) {
  const el = document.createElement("section");
  el.className = "jfa-section";
  const h = document.createElement("h2");
  h.textContent = title;
  el.appendChild(h);
  return el;
}

export function renderFormView(profile) {
  const frag = document.createDocumentFragment();

  const personal = section("Personal");
  for (const key of PERSONAL_ORDER) {
    personal.appendChild(field(`personal.${key}`, profile.personal?.[key]));
  }
  frag.appendChild(personal);

  const links = section("Links");
  for (const key of Object.keys(profile.links || {})) {
    links.appendChild(field(`links.${key}`, profile.links[key]));
  }
  frag.appendChild(links);

  const prefs = section("Job preferences");
  for (const key of PREF_ORDER) {
    prefs.appendChild(field(`jobPreferences.${key}`, profile.jobPreferences?.[key]));
  }
  frag.appendChild(prefs);

  const auth = section("Work authorization");
  const wa = profile.workAuthorization || {};
  auth.appendChild(field("workAuthorization.citizenOf", wa.citizenOf));
  auth.appendChild(field("workAuthorization.authorizedToWorkIn",
    Array.isArray(wa.authorizedToWorkIn) ? wa.authorizedToWorkIn.join(", ") : ""));
  auth.appendChild(field("workAuthorization.requiresSponsorshipOutsideIndia",
    wa.requiresSponsorshipOutsideIndia));
  auth.appendChild(field("workAuthorization.note", wa.note));
  frag.appendChild(auth);

  const div = section("Diversity");
  for (const key of Object.keys(profile.diversity || {})) {
    div.appendChild(field(`diversity.${key}`, profile.diversity[key]));
  }
  frag.appendChild(div);

  const rules = section("Truth rules");
  (profile.truthRules || []).forEach((rule, i) => {
    rules.appendChild(field(`truthRules[${i}]`, rule));
  });
  frag.appendChild(rules);

  const roles = section("Role angles");
  for (const key of Object.keys(profile.roles || {})) {
    const h = document.createElement("h3");
    h.textContent = profile.roles[key].label || key;
    roles.appendChild(h);
    roles.appendChild(field(`roles.${key}.label`, profile.roles[key].label));
    roles.appendChild(field(`roles.${key}.headline`, profile.roles[key].headline));
    roles.appendChild(field(`roles.${key}.emphasis`, profile.roles[key].emphasis));
  }
  frag.appendChild(roles);

  return frag;
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i].match(/^(.+)\[(\d+)\]$/);
    if (m) {
      node[m[1]] = node[m[1]] || [];
      node[m[1]][Number(m[2])] = node[m[1]][Number(m[2])] || {};
      node = node[m[1]][Number(m[2])];
    } else {
      node[parts[i]] = node[parts[i]] || {};
      node = node[parts[i]];
    }
  }
  const last = parts[parts.length - 1];
  const m = last.match(/^(.+)\[(\d+)\]$/);
  if (m) {
    node[m[1]] = node[m[1]] || [];
    node[m[1]][Number(m[2])] = value;
  } else {
    node[last] = value;
  }
}


const NUMBER_PATHS = new Set(["jobPreferences.totalExperienceYears"]);

export function readFormView(root, base) {
  const out = base ? structuredClone(base) : {};
  for (const el of root.querySelectorAll("[data-path]")) {
    const path = el.dataset.path;
    let value = el.value;
    if (BOOLEAN_PATHS.has(path)) value = value === "true";
    else if (LIST_PATHS.has(path)) {
      value = value.split(",").map((s) => s.trim()).filter(Boolean);
    }
    else if (NUMBER_PATHS.has(path)) {
      const n = Number(value);
      value = value.trim() === "" || Number.isNaN(n) ? value : n;
    }
    setPath(out, path, value);
  }
  return out;
}
