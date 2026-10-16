import type { ReactNode } from 'react';
import {
  AlertCircle,
  ArrowRight,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react';

import { Link } from '@/core/i18n/navigation';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function AuthStatusCard({
  brand,
  title,
  description,
  busy = false,
  error = false,
  actionLabel,
  onAction,
  actionDisabled = false,
  accountUrl,
  accountLabel,
  homeLabel,
  children,
}: {
  brand: string;
  title: string;
  description: string;
  busy?: boolean;
  error?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  accountUrl?: string;
  accountLabel?: string;
  homeLabel: string;
  children?: ReactNode;
}) {
  return (
    <main className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link href="/" className="self-center font-serif text-lg italic">
          {brand}
        </Link>
        <Card>
          <CardHeader
            className="text-center"
            role={error ? 'alert' : 'status'}
            aria-live="polite"
          >
            <div className="bg-primary/5 text-primary mx-auto mb-4 flex size-12 items-center justify-center rounded-xl">
              {busy ? (
                <LoaderCircle className="size-6 animate-spin" />
              ) : error ? (
                <AlertCircle className="text-destructive size-6" />
              ) : (
                <ShieldCheck className="size-6" />
              )}
            </div>
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription className="mt-2 leading-7">
              {description}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {children}
            {actionLabel && onAction && (
              <Button
                className="w-full"
                onClick={onAction}
                disabled={actionDisabled}
              >
                {busy && <LoaderCircle className="size-4 animate-spin" />}
                {actionLabel}
                <ArrowRight className="size-4" />
              </Button>
            )}
            {accountUrl && (
              <a
                href={accountUrl}
                rel="noopener noreferrer"
                className="text-primary text-center text-sm underline underline-offset-4"
              >
                {accountLabel}
              </a>
            )}
            <Link
              href="/"
              className="text-muted-foreground text-center text-sm underline underline-offset-4"
            >
              {homeLabel}
            </Link>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
