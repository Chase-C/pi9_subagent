export type AskOption = {
  label: string;
  description?: string;
};

export type AskParams = {
  question: string;
  context?: string;
  options?: AskOption[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
};

export type ValidatedAskParams = {
  question: string;
  context?: string;
  options: AskOption[];
  allowMultiple: boolean;
  allowFreeform: boolean;
};

export type AskSelection = AskOption & {
  comment?: string;
};

export type AskAnswer = {
  selections: AskSelection[];
  freeform?: string;
};

export type AskAnsweredDetails = {
  status: "answered";
  question: string;
  answer: AskAnswer;
};

export type AskCancelledDetails = {
  status: "cancelled";
  question: string;
};

export type AskUiUnavailableDetails = {
  status: "ui_unavailable";
  question: string;
};

export type AskToolDetails = AskAnsweredDetails | AskCancelledDetails | AskUiUnavailableDetails;

export type AskResponse = {
  content: Array<{ type: "text"; text: string }>;
  details: AskToolDetails;
};
