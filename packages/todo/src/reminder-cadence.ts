export interface ReminderCadenceConfig {
  minTurns: number;
  maxTurns: number;
  outputTokens: number;
  maxPerRun: number;
}

export interface ReminderCadenceState {
  turns: number;
  outputTokens: number;
  remindersThisRun: number;
}

export interface ConsumeReminderResult {
  due: boolean;
  state: ReminderCadenceState;
}

export function createReminderCadenceState(): ReminderCadenceState {
  return { turns: 0, outputTokens: 0, remindersThisRun: 0 };
}

export function resetReminderCadence(): ReminderCadenceState {
  return createReminderCadenceState();
}

export function beginReminderAgentRun(state: ReminderCadenceState): ReminderCadenceState {
  return { ...state, remindersThisRun: 0 };
}

export function noteReminderTurn(
  state: ReminderCadenceState,
  outputTokens: number = 0,
): ReminderCadenceState {
  return {
    ...state,
    turns: state.turns + 1,
    outputTokens: state.outputTokens + nonnegative(outputTokens),
  };
}

export function noteTodoInteraction(state: ReminderCadenceState): ReminderCadenceState {
  return { ...state, turns: 0, outputTokens: 0 };
}

export function consumeDueReminder(
  state: ReminderCadenceState,
  config: ReminderCadenceConfig,
): ConsumeReminderResult {
  const minimumMet = state.turns >= nonnegative(config.minTurns);
  const triggerMet = state.turns >= nonnegative(config.maxTurns)
    || state.outputTokens >= nonnegative(config.outputTokens);
  const belowCap = state.remindersThisRun < nonnegative(config.maxPerRun);

  if (!minimumMet || !triggerMet || !belowCap) return { due: false, state };

  return {
    due: true,
    state: {
      turns: 0,
      outputTokens: 0,
      remindersThisRun: state.remindersThisRun + 1,
    },
  };
}

function nonnegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
