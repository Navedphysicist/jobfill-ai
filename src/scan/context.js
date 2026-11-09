import { textOf } from "./labels.js";

function jobPosting(doc) {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const items = Array.isArray(data) ? data : data["@graph"] || [data];
      const jp = items.find((i) => i && i["@type"] === "JobPosting");
      if (jp) return jp;
    } catch { /* malformed JSON-LD: ignore */ }
  }
  return null;
}

// Vendors that put the employer in the subdomain vs. in the first path segment.
const SUBDOMAIN_VENDORS = ["myworkdayjobs.com", "icims.com", "applytojob.com", "bamboohr.com", "recruitee.com", "teamtailor.com"];
const PATH_VENDORS = ["greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com",
  "jobvite.com", "taleo.net", "successfactors.com", "workday.com"];
const SECOND_LEVEL = ["co", "com", "org", "net", "gov", "ac", "edu"];
const GENERIC_SEGMENTS = ["jobs", "job", "careers", "apply", "en", "en-us", "embed", "j"];

const onHost = (host, list) => list.some((v) => host === v || host.endsWith("." + v));

function hostCompany(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (onHost(host, SUBDOMAIN_VENDORS)) {
      return host.split(".")[0].replace(/^(careers|jobs)-/, "");
    }
    if (onHost(host, PATH_VENDORS)) {
      return u.pathname.split("/").filter(Boolean).find((x) => !GENERIC_SEGMENTS.includes(x.toLowerCase())) || "";
    }
    let parts = host.split(".");
    const n = parts.length;
    if (n >= 3 && parts[n - 1].length === 2 && SECOND_LEVEL.includes(parts[n - 2])) parts = parts.slice(0, -2);
    else parts = parts.slice(0, -1);
    return parts[parts.length - 1] || "";
  } catch {
    return "";
  }
}

export function pageContext(doc, url) {
  const jp = jobPosting(doc);
  const meta = (p) => doc.querySelector(`meta[property="${p}"]`)?.getAttribute("content")?.trim() || "";
  const org = jp?.hiringOrganization;
  const company = (typeof org === "string" ? org : org?.name) || meta("og:site_name") || hostCompany(url);
  const jobTitle = jp?.title || meta("og:title") || textOf(doc.querySelector("h1")) || doc.title || "";
  let host = "";
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  const text = `${doc.title || jobTitle} — ${host}`;
  return { company, jobTitle, text };
}
