import type { Task } from './model';
import type { PageState } from './ports';

export type EventDetails = NonNullable<Task['events'][number]['details']>;

const unavailable: Record<NonNullable<PageState['buyUnavailableReason']>, string> = {
  'missing-form': 'форму покупки не знайдено', 'missing-product': 'у формі немає ID товару',
  'missing-button': 'кнопки немає на сторінці', 'hidden-button': 'кнопка прихована',
  'disabled-button': 'кнопка вимкнена', 'blocked-container': 'сайт заблокував блок покупки',
  limited: 'сайт позначив кнопку як limited (обмеження покупки)', pending: 'додавання вже обробляється',
};

export function describePage(state: PageState): string {
  const reasons = [
    state.inCart && (state.cartConfirmation === 'visible-cart'
      ? 'товар підтверджено у видимому кошику однієї з вкладок профілю' : 'сторінка підтверджує товар у кошику'),
    state.rateLimited && (state.sharedRateLimit ? 'спільна пауза 429 для монет' : 'сторінка повернула 429'),
    state.challenge && 'захист браузера Bunny Shield', state.turnstile && 'перевірка Turnstile',
    state.login === 'logged-out' && 'немає входу в акаунт', state.login === 'unknown' && 'стан входу не розпізнано',
    state.queuePosition && `черга: ${state.queuePosition}`,
    state.purchasePending && 'магазин обробляє додавання',
    state.buyAvailable ? 'кнопка покупки доступна'
      : `кнопка недоступна: ${state.buyUnavailableReason ? unavailable[state.buyUnavailableReason] : 'причину не розпізнано'}`,
  ].filter(Boolean);
  return `Стан сторінки: ${reasons.join('; ')}.`;
}

export const CONNECTION_LOST_NOTE = 'Вкладку або з’єднання з браузером закрито.';

// Classify known failures without persisting provider messages, URLs, tokens or stacks.
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('Page state changed before purchase click')) return 'Стан сторінки змінився перед кліком; кнопку не натиснуто.';
  if (message.includes('Browser left the selected product page')) return 'Вкладка перейшла з обраної сторінки монети.';
  if (message.includes('Purchase outcome is unknown after recovery')) return 'Після відновлення від 429 підтвердження покупки немає; повтор заблоковано.';
  if (/Target.*closed|page.*closed|browser.*closed/i.test(message)) return CONNECTION_LOST_NOTE;
  if (error instanceof Error && (error.name === 'TimeoutError' || /timeout|timed out/i.test(message))) return 'Перевищено час очікування операції.';
  if (/net::ERR_|ECONN|ENOTFOUND|socket hang up/i.test(message)) return 'Помилка мережевого з’єднання.';
  return 'Нерозпізнана помилка операції; дивіться етап і останній стан сторінки.';
}
