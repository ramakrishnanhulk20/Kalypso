import deployment from "../../contracts/deployments/testnet.json";
import showcaseRecord from "../../contracts/deployments/showcase-testnet.json";

export const networkPassphrase = deployment.networkPassphrase;
export const rpcUrl = "https://soroban-testnet.stellar.org";
export const horizonUrl = "https://horizon-testnet.stellar.org";

export const contracts = {
  payroll: deployment.contracts.payroll.id,
  token: deployment.contracts.token.id,
};

export const showcase = {
  companyId: BigInt(showcaseRecord.company.id),
  label: showcaseRecord.company.label,
  treasury: showcaseRecord.company.treasury,
  fromLedger: showcaseRecord.fromLedger,
};

// Published on purpose so anyone can check the demo: this key opens only the
// showcase company's payments (threat model C34 and C47). Never bind a real
// account to it.
export const demoAccountantSecret = BigInt(
  showcaseRecord.accountant.demoAccountantKeyPublishedOnPurpose,
);

export const payrollVersion = deployment.contracts.payroll.version;
