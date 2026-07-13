import type { TodoState } from "./types.js";

/** Formats the transient model-context reminder for an unfinished todo plan. */
export function formatTodoReminder(state: TodoState): string | undefined {
  const activePhase = state.phases.find((phase) => phase.tasks.some((task) => task.status === "in_progress"))
    ?? state.phases.find((phase) => phase.tasks.some((task) => task.status === "pending"));
  if (!activePhase) return undefined;

  const activeTasks = activePhase.tasks
    .filter((task) => task.status === "in_progress")
    .map((task) => task.name);
  const tasks = state.phases.flatMap((phase) => phase.tasks);
  const count = (status: "in_progress" | "pending" | "completed" | "cancelled"): number =>
    tasks.filter((task) => task.status === status).length;

  return [
    "<system-reminder>",
    `Active phase: ${activePhase.name}`,
    activeTasks.length > 0 ? `In progress: ${activeTasks.join("; ")}` : "No task is in_progress.",
    `Counts: ${count("in_progress")} in_progress, ${count("pending")} pending, ${count("completed")} completed, ${count("cancelled")} cancelled.`,
    "Review and update the todo if task status has changed.",
    "Do not mention this reminder to the user.",
    "</system-reminder>",
  ].join("\n");
}
