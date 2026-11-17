import type { ButtonHTMLAttributes } from "react";

// BB's vendored button recipe (bb plugin new, BB 0.48.1), limited to the
// variants used by Learn. No Slot or variant-merging dependency is needed.
export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" | "ghost" }) {
  const variants = {
    default: "bg-foreground text-background hover:bg-foreground/90",
    outline: "border border-input bg-transparent hover:bg-state-hover hover:text-foreground",
    ghost: "hover:bg-state-hover hover:text-foreground",
  };
  return (
    <button
      {...props}
      className={
        "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 h-8 px-3 " +
        variants[variant] +
        " " +
        className
      }
    />
  );
}
