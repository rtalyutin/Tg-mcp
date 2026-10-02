// Public editorial data from the verified preview. No credentials or private records.
export const contentRevision = 'ownsite-cards-2026-09-29-v3';

export const seedWorks = [
  {
    id: 'ycs', slug: 'ycs', title: 'ЯрКиберСезон', display_title: 'ЯКС', kind: 'it',
    category: 'Турнирная система', status: 'Сайт и Mini App работают',
    role: 'Основатель и продуктовый владелец; организация турниров, постановка задач и координация реализации',
    summary: 'Турнир живёт не в одной афише: сайт и Mini App связывают сезоны, команды, матчи, итоги и архив.',
    theme: 'arena', orientation: 'landscape',
    live_url: 'https://xn--90aiaibl0ahlel5n.xn--p1ai/',
    embed_allowed: 1,
    links_json: JSON.stringify([
      { label: 'Открыть сайт ЯКС', href: 'https://xn--90aiaibl0ahlel5n.xn--p1ai/' },
      { label: 'Открыть Mini App', href: 'https://xn--90aiaibl0ahlel5n.xn--p1ai/tg' }
    ]),
    poster: '/assets/ycs-backdrop.jpg', featured_order: 1, catalogue_order: 1, show: 1,
    reveal_json: JSON.stringify([
      { heading: 'Задача', body: 'Связать правила, матчи, команды, зрительский путь и цифровые инструменты в одну работающую систему сезонов CS2 и Dota 2.' },
      { heading: 'Решение', body: 'Сайт хранит текущий сезон и архив, а Mini App даёт компактный мобильный вход в турнир. Пасхалка и HUD не выдаются за одинаково запущенные части.' },
      { heading: 'Проверить', body: 'Откройте сайт или Mini App, перейдите к турниру и смените раздел. Оба публичных входа проверены 29 сентября 2026 года.' }
    ])
  },
  {
    id: 'stories', slug: 'stories', title: 'Недетские сказки', kind: 'authorial', category: 'Истории', status: 'Публикация требует повторной проверки',
    role: 'Инициатор проекта, сюжетные решения и редактура; авторство иллюстраций указывается отдельно',
    summary: 'Истории для взрослого читателя продолжаются в рисунках, комиксах и последовательности публикаций.',
    theme: 'folio', orientation: 'portrait', catalogue_order: 2, show: 0,
    reveal_json: JSON.stringify([{ heading: 'Граница', body: 'Подтверждённый ранее пост не открылся при текущей проверке; карточка останется скрытой до повторной проверки ссылки.' }])
  },
  {
    id: 'booking', slug: 'booking', title: 'Онлайн-запись', kind: 'it', category: 'Сервис', status: 'В реализации',
    role: 'Постановка сценариев, бизнес-правил и критериев приёмки',
    summary: 'Запись через сообщество VK с управлением мастерами, кабинетами и конфликтами расписания.',
    theme: 'neutral', orientation: 'portrait', catalogue_order: 3, show: 0,
    reveal_json: JSON.stringify([{ heading: 'Граница', body: 'Пакет реализации подготовлен на синтетических данных; сквозная запись через VK пока не подтверждена.' }])
  },
  {
    id: 'winline', slug: 'winline', title: 'Winline', kind: 'it', category: 'Расширение и данные', status: 'Локально проверено частично',
    role: 'Постановка требований и проверка поведения расширения',
    summary: 'История купонов с дозагрузкой превращается в данные для поиска и статистики.',
    theme: 'neutral', orientation: 'landscape', catalogue_order: 4, show: 0,
    reveal_json: JSON.stringify([{ heading: 'Граница', body: 'Дозагрузка и серверная часть проверялись раздельно; живой путь «расширение → сервер → статистика» не подтверждён.' }])
  },
  {
    id: 'tochki', slug: 'tochki', title: 'Точки', kind: 'authorial', category: 'Игра', status: 'Первая сквозная версия',
    role: 'Выбор формата, уточнение правил и критериев расчёта; согласование направления «Тетрадный бунт»',
    summary: 'Цифровая версия игры на тетрадном поле: человек против компьютера, с расчётом захвата.',
    theme: 'folio', orientation: 'landscape', catalogue_order: 5, show: 0,
    reveal_json: JSON.stringify([{ heading: 'Граница', body: 'Локальная первая версия и тест ядра существуют, но сложные контуры и пользовательская приёмка ещё не закрыты.' }])
  },
  {
    id: 'wildberries', slug: 'wildberries', title: 'Карточки для Wildberries', kind: 'content', category: 'Маркетплейс', status: 'Редакционный кандидат',
    role: 'Личный вклад и право показа требуют подтверждения',
    summary: 'Серия изображений настенной полки, её деталей и установки.',
    theme: 'folio', orientation: 'portrait', catalogue_order: 6, show: 0,
    reveal_json: JSON.stringify([{ heading: 'Граница', body: 'До публикации нужно подтвердить роль, право показа и точность изображения товара.' }])
  },
  {
    id: 'dashboard', slug: 'dashboard', title: 'Dashboard', display_title: 'DASHBOARD', kind: 'it', category: 'Карта проектов', status: 'Публичная демо-проекция работает',
    role: 'Постановка требований, решения по отображению и приёмка изменений',
    summary: 'Проекты, задачи и расписания связаны в одной обозримой карте; публичный экран использует демонстрационные данные.',
    theme: 'neutral', orientation: 'landscape',
    live_url: 'https://rtalyutin-tg-mcp-8179.twc1.net/dashboard/',
    embed_allowed: 0,
    links_json: JSON.stringify([{ label: 'Открыть Dashboard', href: 'https://rtalyutin-tg-mcp-8179.twc1.net/dashboard/' }]),
    featured_order: null, catalogue_order: 7, show: 1,
    reveal_json: JSON.stringify([
      { heading: 'Задача', body: 'Сделать состояние нескольких проектов обозримым на большом экране и в мобильном сценарии.' },
      { heading: 'Решение', body: 'Публичная проекция показывает структуру групп, проектов, задач, периодов и автоматизаций на демонстрационных записях.' },
      { heading: 'Граница', body: 'Личные данные и рабочий снимок остаются в закрытом контуре. Суточное автообновление не заявляется готовой функцией.' }
    ])
  },
  {
    id: 'sparrow-webmcp', slug: 'sparrow-webmcp', title: 'Sparrow — WebMCP', kind: 'it', category: 'Инструменты агента', status: 'Клиентский комплект подготовлен',
    role: 'Постановка задачи и определение границы клиентской поставки',
    summary: 'Публичное содержимое сайта превращается в точные инструменты поиска и чтения для агента.',
    theme: 'neutral', orientation: 'landscape', catalogue_order: 8, show: 0,
    reveal_json: JSON.stringify([{ heading: 'Граница', body: 'Локальная поставка подготовлена; установка на доменах и публичная точка вызова не подтверждены.' }])
  },
  {
    id: 'postgres-audit', slug: 'postgres-audit', title: 'Аудит PostgreSQL', kind: 'it', category: 'Аналитика', status: 'Материалы подготовлены',
    role: 'Точный персональный вклад и право публичного показа требуют согласования',
    summary: 'Профиль запросов и зависимости превращены в план проверяемой модернизации аналитической БД.',
    theme: 'neutral', orientation: 'landscape', catalogue_order: 9, show: 0,
    reveal_json: JSON.stringify([{ heading: 'Граница', body: 'Внедрение, нагрузочные испытания и достигнутое ускорение не подтверждены; данные заказчика не публикуются.' }])
  }
];
