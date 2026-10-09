"use client";

import { BooksPanel } from "./books-panel";
import { KeyPanel } from "./key-panel";

export function AccountantConsole() {
  return (
    <>
      <h1 className="sr-only">Accountant</h1>
      <KeyPanel />
      <BooksPanel />
    </>
  );
}
