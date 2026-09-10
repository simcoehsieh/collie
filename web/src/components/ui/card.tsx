import * as React from "react";

import { cn } from "@/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        // FORK: softer container radius (xl = 20px) and the tinted elevation token.
        "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-card",
        className,
      )}
      {...props}
    />
  );
}

export { Card };
