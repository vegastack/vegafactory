'use client'

export default function ErrorPage({ error: _error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <section role="alert" className="border-border bg-muted rounded-lg border p-6">
        <h1 className="text-xl font-medium">Dashboard data could not be read</h1>
        <p className="text-muted-foreground mt-2 text-sm">The local read failed before a safe report was available. No dashboard state was changed.</p>
        <button
          type="button"
          onClick={reset}
          className="bg-primary text-primary-foreground hover:bg-accent hover:text-accent-foreground mt-5 rounded-md px-4 py-2 text-sm font-medium"
        >
          Retry this read
        </button>
      </section>
    </main>
  )
}
