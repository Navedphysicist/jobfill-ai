// src/profile/schema.js
export const ROLE_KEYS = ["genai", "swe", "trainer"];

const REQUIRED_SECTIONS = [
  "personal", "links", "education", "experience", "skills",
  "languages", "workAuthorization", "jobPreferences", "diversity",
  "truthRules", "roles"
];

const OBJECT_SECTIONS = [
  "personal", "links", "workAuthorization", "jobPreferences", "diversity", "roles"
];
const REQUIRED_PREFS = ["noticePeriod", "currentSalary", "expectedSalary"];

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

const REQUIRED_PERSONAL = ["fullName", "firstName", "lastName", "email", "phone"];
const ROLE_FIELDS = ["label", "headline", "emphasis"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validateProfile(profile) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });

  if (!isObject(profile)) {
    add("", "profile must be an object");
    return { valid: false, errors };
  }

  for (const section of REQUIRED_SECTIONS) {
    if (profile[section] === undefined || profile[section] === null) {
      add(section, "required section is missing");
    }
  }

  for (const section of OBJECT_SECTIONS) {
    const v = profile[section];
    if (v !== undefined && v !== null && !isObject(v)) {
      add(section, "must be an object");
    }
  }

  if (isObject(profile.personal)) {
    for (const field of REQUIRED_PERSONAL) {
      if (!isNonEmptyString(profile.personal[field])) add(`personal.${field}`, "is required");
    }
    if (profile.personal.email && !EMAIL_RE.test(profile.personal.email)) {
      add("personal.email", "must be a valid email address");
    }
  }

  if (isObject(profile.jobPreferences)) {
    for (const field of REQUIRED_PREFS) {
      if (!isNonEmptyString(profile.jobPreferences[field])) {
        add(`jobPreferences.${field}`, "must be a non-empty string");
      }
    }
  }

  if (isObject(profile.workAuthorization)) {
    if (!isNonEmptyString(profile.workAuthorization.citizenOf)) {
      add("workAuthorization.citizenOf", "must be a non-empty string");
    }
    if (!Array.isArray(profile.workAuthorization.authorizedToWorkIn)) {
      add("workAuthorization.authorizedToWorkIn", "must be an array");
    }
  }

  for (const key of ["truthRules", "skills"]) {
    if (Array.isArray(profile[key])) {
      profile[key].forEach((item, i) => {
        if (!isNonEmptyString(item)) add(`${key}[${i}]`, "must be a non-empty string");
      });
    }
  }

  for (const key of ["education", "experience", "skills", "languages", "truthRules"]) {
    if (profile[key] !== undefined && !Array.isArray(profile[key])) {
      add(key, "must be an array");
    }
  }

  if (Array.isArray(profile.experience)) {
    profile.experience.forEach((entry, i) => {
      if (!entry?.company) add(`experience[${i}].company`, "is required");
      if (!Array.isArray(entry?.bullets)) {
        add(`experience[${i}].bullets`, "must be an array");
      } else {
        entry.bullets.forEach((b, j) => {
          if (typeof b !== "string") add(`experience[${i}].bullets[${j}]`, "must be a string");
        });
      }
    });
  }

  if (isObject(profile.roles)) {
    for (const key of Object.keys(profile.roles)) {
      if (!ROLE_KEYS.includes(key)) {
        add(`roles.${key}`, `unknown role key; expected one of ${ROLE_KEYS.join(", ")}`);
      }
    }
    for (const key of ROLE_KEYS) {
      const role = profile.roles[key];
      if (!isObject(role)) {
        add(`roles.${key}`, "is required");
        continue;
      }
      for (const field of ROLE_FIELDS) {
        if (!role[field]) add(`roles.${key}.${field}`, "is required");
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
