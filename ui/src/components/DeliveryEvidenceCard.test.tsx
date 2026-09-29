import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeliveryEvidenceCard } from "./DeliveryEvidenceCard";

describe("DeliveryEvidenceCard", () => {
  it("separates run attempts, registered artifacts, review, and product acceptance", () => {
    const html = renderToStaticMarkup(
      <DeliveryEvidenceCard
        runAttempts={17}
        evidence={{
          windowDays: 14,
          registeredWorkProducts: 3,
          approvedStatusWorkProducts: 1,
          productAcceptance: "untracked",
        }}
      />,
    );

    expect(html).toContain("Run attempts");
    expect(html).toContain("Registered work products");
    expect(html).toContain("Marked approved (self reported)");
    expect(html).toContain("Product acceptance is not tracked here");
    expect(html).not.toContain("Product accepted");
  });
});
