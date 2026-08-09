/**
 * Formatting tests (FR-LANG-001: DD/MM/YYYY, IST). The calendar-date
 * formatter must be pure string work — a Date-parse implementation would
 * shift dates for users west of IST, which is exactly the bug these
 * pin down.
 */

import { describe, expect, it } from "vitest";
import { TaskPriority, TaskState } from "../../gen/stigmer/law/task/v1/task_pb.js";
import {
  formatCalendarDate,
  formatInstant,
  taskPriorityLabel,
  taskStateLabel,
} from "../format.js";

describe("formatCalendarDate", () => {
  it("renders the contract's YYYY-MM-DD as DD/MM/YYYY", () => {
    expect(formatCalendarDate("2026-08-20")).toBe("20/08/2026");
    expect(formatCalendarDate("2026-01-02")).toBe("02/01/2026");
  });

  it("passes through anything that is not a calendar date, rather than guessing", () => {
    expect(formatCalendarDate("")).toBe("");
    expect(formatCalendarDate("not-a-date")).toBe("not-a-date");
  });
});

describe("formatInstant", () => {
  it("renders in IST regardless of the machine's timezone", () => {
    // 2026-08-09T18:30:00Z is 2026-08-10 00:00 IST — the day boundary
    // case a UTC or US-timezone machine would get wrong.
    expect(formatInstant(new Date("2026-08-09T18:30:00Z"))).toBe("10/08/2026, 00:00");
  });
});

describe("labels", () => {
  it("names every task state and priority in the user's words", () => {
    expect(taskStateLabel(TaskState.OPEN)).toBe("Open");
    expect(taskStateLabel(TaskState.IN_PROGRESS)).toBe("In progress");
    expect(taskStateLabel(TaskState.CLOSED)).toBe("Closed");
    expect(taskPriorityLabel(TaskPriority.LOW)).toBe("Low");
    expect(taskPriorityLabel(TaskPriority.HIGH)).toBe("High");
    // UNSPECIFIED renders as the domain default, matching the server's
    // default-priority step.
    expect(taskPriorityLabel(TaskPriority.UNSPECIFIED)).toBe("Medium");
  });
});
