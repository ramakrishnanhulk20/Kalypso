// Every step the employer and accountant libraries report to the screen, by a stable id. The
// screen shows the sentence messages/<locale>.json holds under progress.<id>, so no English from
// a library reaches a page in another language; the messages test fails if an id has no sentence.
export const PROGRESS_STEPS = [
  "keys_treasury",
  "keys_company",
  "keys_accountant",
  "keys_books",
  "treasury_open",
  "balance_checking",
  "balance_rebuilt",
  "balance_saved",
  "balance_empty",
  "trustline_ready",
  "trustline_sending",
  "deposit_checking_earlier",
  "deposit_sending",
  "deposit_resumed",
  "deposit_incoming",
  "merge_sending",
  "merge_done",
  "rebuild_running",
  "rebuild_ready",
  "rebuild_matches",
  "rebuild_differs",
  "invite_already_active",
  "invite_already_invited",
  "invite_sending",
  "invite_done",
  "run_opening",
  "run_already_closed",
  "run_open",
  "pay_proving",
  "pay_submitted",
  "pay_landed",
  "pay_already_paid",
  "pay_failed",
  "run_stays_open",
  "run_closing",
  "run_closed",
  "setup_checking_accountant",
  "setup_accountant_ok",
  "setup_treasury_ready",
  "setup_company_exists",
  "setup_looking",
  "setup_proving",
  "setup_registering",
  "setup_registered",
  "setup_creating",
  "setup_created",
  "accountant_key_ready",
  "accountant_id_held",
  "accountant_registering",
  "accountant_registered",
  "own_books_number",
  "own_books_checking",
  "own_books_checked",
  "books_key_holds",
  "books_history_start",
  "books_history",
  "books_opening",
  "books_opened",
] as const;

export type ProgressStep = (typeof PROGRESS_STEPS)[number];

/** What a step's sentence names: ids, counts, a line, the run's label. Never an amount. */
export type ProgressValues = Record<string, string | number>;

/** One progress message for the screen: the step's id and the values its sentence names. */
export interface ConsoleProgress {
  step: ProgressStep;
  values?: ProgressValues;
  done: number;
  total: number;
  txHash?: string;
}

export type OnProgress = (p: ConsoleProgress) => void;
