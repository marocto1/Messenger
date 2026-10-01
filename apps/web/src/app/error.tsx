'use client';
import { Brand } from '../components/ui';
export default function ErrorScreen({ reset }: { error: Error & { digest?:string }; reset:()=>void }) {
  return <main className="loading"><Brand /><h1>Не удалось открыть экран</h1><p>Перезагрузи его. Сохранённые черновики и исходящие останутся на устройстве.</p><button className="primaryButton" onClick={reset}>Попробовать снова</button></main>;
}
