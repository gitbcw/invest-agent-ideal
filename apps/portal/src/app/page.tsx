import { redirect } from "next/navigation";

export default function HomePage() {
  // middleware 会处理重定向,这里仅做兜底
  redirect("/chat");
}
