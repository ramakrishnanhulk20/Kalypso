import type { Company } from "@kalypso/core";
import { getCompany, isPayrollError, PayrollErrorCode } from "@kalypso/core";
import { ShownMessage } from "@/components/app/errors";
import { loadEmployer } from "@/components/app/loaders";
import type { WalletPort } from "@/lib/wallet/port";

const MAX_U64 = 0xffff_ffff_ffff_ffffn;

/** A company id typed by a person: whole digits that fit the contract's u64, or the lib's own refusal. */
export async function companyIdFrom(text: string): Promise<bigint> {
  const trimmed = text.trim();
  if (/^\d{1,20}$/.test(trimmed) && BigInt(trimmed) <= MAX_U64) return BigInt(trimmed);
  const { ConsoleError } = await loadEmployer();
  throw new ConsoleError("COMPANY_ID_INVALID");
}

/** The company as the payroll contract holds it, refused unless this wallet is its admin. */
export async function readAdminCompany(wallet: WalletPort, companyId: bigint): Promise<Company> {
  const lib = await loadEmployer();
  const { port, config } = lib.consoleContext();
  let company: Company;
  try {
    company = await getCompany(port, config.contracts.payroll, companyId);
  } catch (err) {
    if (isPayrollError(err, PayrollErrorCode.CompanyNotFound)) throw new lib.ConsoleError("COMPANY_NOT_FOUND");
    throw err;
  }
  if (company.admin !== wallet.address) throw new ShownMessage(`This wallet is not the admin of company #${companyId}.`);
  return company;
}

/** True when the company's books are sealed to an accountant id whose key is published on purpose. */
export async function publiclyReadable(company: Company): Promise<boolean> {
  const lib = await loadEmployer();
  return lib.isPublishedDemoAccountant(lib.consoleContext().config.contracts.auditor, company.auditorId);
}
