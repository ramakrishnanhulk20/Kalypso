import type { ReactNode } from "react";
import { PubliclyReadable } from "./public-chip";

// What a join leaves on the page: the company, its accept transaction (children), and the Publicly
// readable chip when the company is bound to the published demo accountant key (C47).
export function JoinedLine({ label, publiclyReadable, children }: { label: string; publiclyReadable: boolean; children?: ReactNode }) {
  return (
    <>
      <span className="t-label break-words">Joined {label}</span>
      {children}
      {publiclyReadable ? <PubliclyReadable /> : null}
    </>
  );
}
