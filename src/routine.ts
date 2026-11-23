import { readFileSync } from "node:fs";

export interface RoutineVars {
  githubRepo: string;
  githubBranch: string;
  resultsDir: string;
}

function template(name: string): string {
  return readFileSync(new URL(`../routine/${name}`, import.meta.url), "utf8");
}

function fill(text: string, vars: RoutineVars): string {
  return text
    .replaceAll("{{REPO}}", vars.githubRepo)
    .replaceAll("{{BRANCH}}", vars.githubBranch)
    .replaceAll("{{RESULTS_DIR}}", vars.resultsDir);
}

export function renderDeliverScript(vars: RoutineVars): string {
  return fill(template("deliver.template.py"), vars);
}

/** The text to paste into the xscout routine's Instructions field in Grok Bot. */
export function renderRoutineInstructions(vars: RoutineVars): string {
  return fill(template("INSTRUCTIONS.template.md"), vars).replace("{{DELIVER_SCRIPT}}", renderDeliverScript(vars).trimEnd());
}

/** A chat message asking Grok Bot to create the routine itself, with the instructions embedded. */
export function renderCreateRoutineMessage(vars: RoutineVars): string {
  return template("CREATE_ROUTINE_MESSAGE.template.md").replace("{{INSTRUCTIONS}}", renderRoutineInstructions(vars).trimEnd());
}
