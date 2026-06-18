import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="rounded-lg border border-border bg-card p-8 text-center shadow-md">
        <h2 className="text-h3 font-semibold text-foreground">
          Page not found
        </h2>
        <p className="mt-2 text-body text-muted-foreground">
          The page you are looking for does not exist.
        </p>
      </div>
    </div>
  );
}
