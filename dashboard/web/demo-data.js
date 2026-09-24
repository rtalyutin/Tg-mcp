/** Figma's approved example data; never a projection of the owner's database.
 * Canonical tasks occur once. Project membership is a separate many-to-many relation.
 */
export const stages = [
  { id: 'idea', title: 'Идея' },
  { id: 'spec', title: 'ТЗ' },
  { id: 'build', title: 'Реализация' },
  { id: 'production', title: 'Внедрение в прод' },
];
export const projects = [
  { id: 'tournament', title: 'ЯКС · октябрьский турнир', icon: 'folder' },
  { id: 'miniapp', title: 'ЯКС · Telegram Mini App', icon: 'phone' },
  { id: 'mcp', title: 'Telegram MCP', icon: 'plug' },
  { id: 'stories', title: 'Сказки доброго Медведя', icon: 'book' },
  { id: 'career', title: 'Поиск работы', icon: 'briefcase' },
];
export const tasks = [
  { id: 'cover', title: 'Определить отправку обложки', stage: 'idea', progress: null, projectIds: ['mcp'] },
  { id: 'career-step', title: 'Выбрать следующий карьерный шаг', stage: 'idea', progress: null, projectIds: ['career'] },
  { id: 'connection', title: 'Подготовить рабочее подключение MCP', stage: 'spec', progress: null, projectIds: ['mcp', 'stories'] },
  { id: 'story-publish', title: 'Перевести публикацию сказок на MCP', stage: 'spec', progress: null, projectIds: ['mcp', 'stories'] },
  { id: 'rosters', title: 'Собрать и подтвердить составы', stage: 'build', progress: 90, projectIds: ['tournament', 'miniapp'] },
  { id: 'sections', title: 'Доделать разделы турнира', stage: 'build', progress: null, projectIds: ['miniapp'] },
  { id: 'deploy', title: 'Развернуть сервис в Timeweb', stage: 'build', progress: null, projectIds: ['mcp'] },
  { id: 'tournament-json', title: 'Проверить единый JSON турнира', stage: 'production', progress: 100, projectIds: ['tournament'] },
  { id: 'miniapp-release', title: 'Приёмка и выпуск Mini App', stage: 'production', progress: null, projectIds: ['miniapp'] },
  { id: 'background-publish', title: 'Проверить фоновую публикацию', stage: 'production', progress: null, projectIds: ['mcp', 'stories'] },
];
export const inbox = [
  { title: 'Симулятор команды ЯКС', description: 'Идея', icon: 'doc' },
  { title: 'Граф навыков', description: 'На разбор', icon: 'chart' },
  { title: 'Курсы MIT для навыков', description: 'Материал', icon: 'cap' },
];
export const priorities = [
  { title: 'Telegram MCP', description: 'Запуск публикаций', number: '1', projectId: 'mcp' },
  { title: 'Октябрьский ЯКС', description: 'Подготовка турнира', number: '2', projectId: 'tournament' },
  { title: 'Поиск работы', description: 'Следующий шаг', number: '3', projectId: 'career' },
];
export const changes = [
  { title: 'Дашборд', description: 'Выбран вариант 3', date: '19.09.2026 · 14:32', dot: true },
  { title: 'Визуализация задач', description: 'Добавлен прогресс в строках', date: '19.09.2026 · 12:17', dot: true },
  { title: 'Компоновка', description: 'Центральная половина экрана', date: '19.09.2026 · 10:03', dot: true },
];
export const automations = [
  { title: 'Сказки доброго Медведя', description: 'Сегодня, 23:30', icon: 'book' },
  { title: 'Самоулучшение ассистента', description: 'Завтра, 06:00', icon: 'settings' },
  { title: 'Поиск новых возможностей', description: 'Ежедневно', icon: 'refresh' },
];
