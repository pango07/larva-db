import { Providers } from "./providers";

export default function ViewerLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
