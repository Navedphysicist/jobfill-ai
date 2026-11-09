import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { migrateV1 } from "../src/profile/migrate.js";

const defaultProfile = JSON.parse(readFileSync("profile.example.json", "utf8"));

const v1 = {
  personal: { fullName: "Jane Doe", firstName: "Jane", lastName: "Doe",
              email: "you@example.com", phone: "+91 90000 00000" },
  links: { linkedin: "https://linkedin.com/in/x", github: "", portfolio: "" },
  headline: "Senior Generative AI Engineer | OLD HEADLINE",
  summary: "Old summary text.",
  experience: [{ title: "T", company: "C", from: "2024-05", to: "Present", bullets: ["b1"] }],
  education: [{ degree: "D", school: "S", from: "2016", to: "2020", gpa: "8.6 / 10" }],
  skills: ["Python"],
  languages: [{ language: "English", proficiency: "Full professional proficiency" }],
  workAuthorization: { citizenOf: "India", authorizedToWorkIn: ["India"],
                       requiresSponsorshipOutsideIndia: true, note: "n" },
  jobPreferences: { noticePeriod: "1 month", currentSalary: "INR 15 LPA",
                    expectedSalary: "INR 30+ LPA", employmentType: "Full-time" },
  diversity: { disability: "No", veteran: "No" },
  truthRules: ["NEVER claim Azure experience — cloud experience is AWS only."]
};

describe("migrateV1", () => {
  const out = migrateV1(v1, defaultProfile);

  it("stamps the v2 schema version", () => {
    expect(out._meta.version).toBe(2);
  });

  it("keeps the user's own facts", () => {
    expect(out.personal.email).toBe("you@example.com");
    expect(out.experience[0].company).toBe("C");
    expect(out.skills).toEqual(["Python"]);
  });

  it("moves the v1 headline into the genai role", () => {
    expect(out.roles.genai.headline).toBe("Senior Generative AI Engineer | OLD HEADLINE");
  });

  it("seeds the two missing role angles from the default", () => {
    expect(out.roles.swe).toEqual(defaultProfile.roles.swe);
    expect(out.roles.trainer).toEqual(defaultProfile.roles.trainer);
  });

  it("applies the three corrected job preference values", () => {
    expect(out.jobPreferences.noticePeriod).toBe("1 month");
    expect(out.jobPreferences.currentSalary).toBe("INR 00,00,000");
    expect(out.jobPreferences.expectedSalary).toBe("INR 00 LPA");
  });

  it("adds the ML/data truth rule without dropping existing rules", () => {
    expect(out.truthRules).toContain(
      "NEVER claim Azure experience — cloud experience is AWS only."
    );
    expect(out.truthRules.join(" ")).toContain("machine learning");
  });

  it("drops the v1 top-level headline and summary", () => {
    expect(out.headline).toBeUndefined();
    expect(out.summary).toBeUndefined();
  });

  it("is idempotent when run on an already-migrated profile", () => {
    const twice = migrateV1(out, defaultProfile);
    const strip = (p) => ({ ...p, _meta: { version: p._meta.version } });
    expect(strip(twice)).toEqual(strip(out));
  });

  it("preserves a user-edited expectedSalary on a v2 profile", () => {
    const v2 = structuredClone(defaultProfile);
    v2.jobPreferences.expectedSalary = "INR 24 LPA";
    expect(migrateV1(v2, defaultProfile).jobPreferences.expectedSalary).toBe("INR 24 LPA");
  });

  it("still corrects a genuine v1 profile (no _meta)", () => {
    const o = migrateV1(v1, defaultProfile);
    expect(o.jobPreferences.expectedSalary).toBe("INR 00 LPA");
  });
});
