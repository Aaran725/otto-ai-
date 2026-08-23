import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="otto-text-title text-otto-text">Sign-in didn&apos;t go through</p>
      <p className="otto-text-body max-w-sm text-otto-text-muted">
        The link may have expired or already been used. Try signing in again.
      </p>
      <Link href="/" className="otto-text-caption mt-2 rounded-full bg-otto-gold px-4 py-1.5 font-medium text-otto-bg">
        Back to Otto
      </Link>
    </div>
  );
}
