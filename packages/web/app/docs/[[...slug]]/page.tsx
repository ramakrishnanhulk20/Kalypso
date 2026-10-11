import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { getMdxComponents } from "@/components/mdx";
import { isEnglishOnly } from "@/lib/i18n/docs-tree";
import { source } from "@/lib/source";

type DocsPageProps = { params: Promise<{ slug?: string[] }> };

export default async function Page({ params }: DocsPageProps) {
  const [{ slug }, locale, t] = await Promise.all([params, getLocale(), getTranslations("docs")]);
  const page = source.getPage(slug, locale);
  if (!page) notFound();

  const Content = page.data.body;

  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      {isEnglishOnly(slug, locale) ? (
        <p className="t-label -mt-2 mb-2 rounded-button border border-line bg-raised px-3 py-2" style={{ textTransform: "none", letterSpacing: "0.04em" }} lang="en">
          {t("englishOnly")}
        </p>
      ) : null}
      <DocsBody>
        <Content components={getMdxComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateMetadata({
  params,
}: DocsPageProps): Promise<Metadata> {
  const [{ slug }, locale, t] = await Promise.all([params, getLocale(), getTranslations("metadata.docs")]);
  const page = source.getPage(slug, locale);
  if (!page) notFound();

  return {
    title: t("title", { page: page.data.title }),
    description: page.data.description,
  };
}
