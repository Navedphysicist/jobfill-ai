import { normalizeUrl, localDate } from "./store.js";
import { pageContext } from "../scan/context.js";

// Pure: reads a document and returns a plain object. It must not import or call the
// store's mutators; the popup (an extension page) performs the write.
// Company and job title are DELEGATED to pageContext so the ATS-vendor handling
// (Workday, Greenhouse, co.uk, ...) lives in exactly one place.

export function captureApplication(doc, url, roleKey) {
  const { company, jobTitle } = pageContext(doc, url);

  let domain = "";
  try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { /* not a url */ }

  return {
    company,
    jobTitle: (jobTitle || "").trim(),
    appliedAt: localDate(),
    state: "Applied",
    domain,
    jobUrl: normalizeUrl(url),
    roleFamily: roleKey || ""
  };
}
