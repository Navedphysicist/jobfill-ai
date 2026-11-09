import { describe, it, expect } from "vitest";
import { renderTable, summarize } from "../src/ui/dashboard/table.js";
import { APPLICATION_STATES } from "../src/track/store.js";

const roleLabels = { genai: "GenAI Engineer", swe: "Software Engineer", trainer: "Trainer / L&D" };
const rows = [
  { id: "a", sno: 2, company: "Swiggy", jobTitle: "SDE-2", appliedAt: "2026-10-11",
    state: "Applied", domain: "swiggy.com", jobUrl: "https://s.com/1",
    roleFamily: "swe", outcomeReason: "", notes: "" },
  { id: "b", sno: 1, company: "Acme", jobTitle: "GenAI Eng", appliedAt: "2026-10-10",
    state: "Rejected", domain: "acme.com", jobUrl: "https://a.com/1",
    roleFamily: "genai", outcomeReason: "No ML depth", notes: "" }
];

function mount() {
  const root = document.createElement("div");
  root.appendChild(renderTable(rows, { roleLabels }));
  return root;
}

describe("renderTable", () => {
  it("renders the columns the spec asks for", () => {
    const heads = Array.from(mount().querySelectorAll("thead th")).map((th) => th.textContent);
    for (const col of ["S.No", "Company", "Date", "State", "Domain", "Reason"]) {
      expect(heads.join("|")).toContain(col);
    }
  });

  it("renders one row per record, in the order given", () => {
    const bodyRows = mount().querySelectorAll("tbody tr");
    expect(bodyRows.length).toBe(2);
    expect(bodyRows[0].dataset.id).toBe("a");
  });

  it("renders the job url as a link", () => {
    const a = mount().querySelector('tbody a[href="https://s.com/1"]');
    expect(a).toBeTruthy();
    expect(a.target).toBe("_blank");
  });

  it("renders state as a select carrying every state", () => {
    const sel = mount().querySelector('tbody select[data-field="state"]');
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(APPLICATION_STATES);
    expect(sel.value).toBe("Applied");
  });

  it("never makes an href from a non-http(s) job url, but keeps the text visible", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>x</script>", "not a url"]) {
      const root = document.createElement("div");
      expect(() => root.appendChild(renderTable([{ ...rows[0], jobUrl: bad }], { roleLabels }))).not.toThrow();
      expect(root.querySelector("tbody a[href]")).toBeNull();
      expect(root.querySelector("tbody").textContent).toContain(bad);
    }
  });

  it("keeps a working anchor for https urls", () => {
    const root = document.createElement("div");
    root.appendChild(renderTable([{ ...rows[0], jobUrl: "https://boards.greenhouse.io/acme/jobs/1" }], { roleLabels }));
    const a = root.querySelector("tbody a[href]");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
  });

  it("shows the role label rather than the key", () => {
    expect(mount().textContent).toContain("Software Engineer");
    expect(mount().textContent).toContain("GenAI Engineer");
  });

  it("renders the rejection reason as an editable input", () => {
    const inputs = mount().querySelectorAll('tbody input[data-field="outcomeReason"]');
    expect(inputs.length).toBe(2);
    expect(Array.from(inputs).map((i) => i.value)).toContain("No ML depth");
  });

  it("renders an empty-state row when there are no records", () => {
    const root = document.createElement("div");
    root.appendChild(renderTable([], { roleLabels }));
    expect(root.querySelector("tbody").textContent).toContain("No applications");
  });
});

describe("summarize", () => {
  it("counts the total and each state", () => {
    const s = summarize(rows);
    expect(s.total).toBe(2);
    expect(s.byState.Applied).toBe(1);
    expect(s.byState.Rejected).toBe(1);
    expect(s.byState["On Hold"]).toBe(0);
  });
});
