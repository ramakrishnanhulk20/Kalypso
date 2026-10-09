import { PayrollErrorCode, getCompany, isPayrollError } from "@kalypso/core";
import type { Company } from "@kalypso/core";
import type { WalletPort } from "../wallet/port";
import type { ConsoleContext } from "./context";
import { ConsoleError } from "./errors";

const MAX_U64 = 0xffff_ffff_ffff_ffffn;

/**
 * The company, read now, refused unless this wallet is its admin. Addresses are compared as the
 * chain's decoder and core's parser both write them, the one canonical G or C text.
 *
 * @throws ConsoleError COMPANY_ID_INVALID, COMPANY_NOT_FOUND or NOT_ADMIN; the network's own error.
 */
export async function adminCompany(ctx: ConsoleContext, wallet: WalletPort, companyId: unknown): Promise<Company> {
  if (typeof companyId !== "bigint" || companyId < 0n || companyId > MAX_U64) throw new ConsoleError("COMPANY_ID_INVALID");
  let company: Company;
  try {
    company = await getCompany(ctx.port, ctx.config.contracts.payroll, companyId);
  } catch (err) {
    if (isPayrollError(err, PayrollErrorCode.CompanyNotFound)) throw new ConsoleError("COMPANY_NOT_FOUND");
    throw err;
  }
  if (company.admin !== wallet.address) throw new ConsoleError("NOT_ADMIN");
  return company;
}
