import type { Step } from "./payslip-paint";

export const STEPS: { n: Step; heading: string; text: string }[] = [
  {
    n: 1,
    heading: "You approve the run.",
    text: "Upload a spreadsheet of who gets what. Kalypso checks every address and amount, then asks you to approve the whole run once.",
  },
  {
    n: 2,
    heading: "Your browser seals it.",
    text: "The amount is encrypted on your machine, and a zero-knowledge proof shows it is a valid payment your treasury can afford, without showing the number.",
  },
  {
    n: 3,
    heading: "The ledger records that it happened.",
    text: "Stellar stores the payment and marks the worker paid for this run. The amount stays sealed for everyone who looks.",
  },
  {
    n: 4,
    heading: "The worker opens their own line.",
    text: "Each worker holds a key that opens their pay and nothing else. Sign in with Face ID or a wallet, read the payslip, cash out.",
  },
  {
    n: 5,
    heading: "The accountant opens the books.",
    text: "Your accountant's key opens every amount the company paid, so audits, payroll tax and year-end still work. Nobody else ever can.",
  },
];

export const READABLE_BY = [
  "You",
  "Nobody yet",
  "Nobody without a key",
  "You · the worker",
  "You · the worker · your accountant",
];
