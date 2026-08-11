/**
 * The DD-005 detail frame's structural contract: the rail is a NAMED
 * complementary landmark (assistive tech can jump between the story and
 * the facts — the axe gate checks landmarks are labeled), and MetaPanel
 * facts are real term/definition pairs, not styled divs.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailLayout } from "../DetailLayout.js";
import { MetaItem, MetaPanel } from "../MetaPanel.js";

describe("DetailLayout", () => {
  it("renders the story column and a named rail landmark", () => {
    render(
      <DetailLayout railLabel="Task facts" rail={<p>the facts</p>}>
        <p>the story</p>
      </DetailLayout>,
    );

    const rail = screen.getByRole("complementary", { name: "Task facts" });
    expect(rail).toHaveTextContent("the facts");
    expect(screen.getByText("the story")).toBeInTheDocument();
  });
});

describe("MetaPanel", () => {
  it("renders facts as term/definition pairs with actions anchored in the footer", () => {
    render(
      <MetaPanel footer={<button type="button">Edit</button>}>
        <MetaItem label="Status">Open</MetaItem>
        <MetaItem label="Priority">High</MetaItem>
      </MetaPanel>,
    );

    expect(screen.getAllByRole("term").map((el) => el.textContent)).toEqual([
      "Status",
      "Priority",
    ]);
    expect(screen.getAllByRole("definition").map((el) => el.textContent)).toEqual([
      "Open",
      "High",
    ]);
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});
