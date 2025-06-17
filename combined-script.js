const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// Общая конфигурация
const config = {
  jira: {
    baseUrl: 'https://jira-stud.udv.group',
    sessionCookie: 'JSESSIONID=9BB0B75DC4316E75F15063AF2179752F',
    batchSize: 100,
    fieldsToSync: ['summary', 'status', 'assignee', 'creator', 'created', 'updated', 'comment']
  },
  glpi: {
    baseUrl: 'http://10.51.4.2/glpi/apirest.php',
    appToken: 'x9K5pICuWiC0yOIyO0XiHslo4k2qZHy4D8ndgeXE',
    userToken: 'UWqcbVIi8Iebwayt2RuUy5DfUASgIIL8dZHKTK7R',
    defaultTicketCategory: 1
  },
  syncStateFile: 'sync-state.json',
  syncInterval: '*/30 * * * *', // Каждые 30 минут
  debug: true
};

// Логирование
function log(message) {
  const timestamp = new Date().toISOString();
  if (config.debug) {
    console.log(`[${timestamp}] ${message}`);
  }
}

// ================== Общие функции ==================

// Получение комментариев из Jira
async function getJiraComments(issueKey) {
  try {
    const response = await axios.get(`${config.jira.baseUrl}/rest/api/2/issue/${issueKey}/comment`, {
      headers: {
        'Cookie': config.jira.sessionCookie,
        'X-Atlassian-Token': 'no-check'
      }
    });
    return response.data.comments || [];
  } catch (error) {
    log(`Ошибка при получении комментариев для ${issueKey}: ${error.message}`);
    return [];
  }
}

// Форматирование данных для GLPI
function formatDataForGlpi(issue, comments) {
  const fields = issue.fields;
  const status = fields.status ? fields.status.name : 'Не указан';
  const assignee = fields.assignee ? fields.assignee.displayName : 'Не назначен';
  const creator = fields.creator ? fields.creator.displayName : 'Не указан';
  
  const commentsText = comments.map(c => 
    `Автор: ${c.author.displayName}\nДата: ${new Date(c.created).toLocaleString()}\n${c.body}\n`
  ).join('\n');

  return {
    name: `${issue.key}: ${fields.summary || 'Без названия'}`.substring(0, 250),
    content: `
      **Задача**: ${issue.key}
      **Статус**: ${status}
      **Исполнитель**: ${assignee}
      **Создатель**: ${creator}
      **Дата создания**: ${new Date(fields.created).toLocaleString()}
      **Дата обновления**: ${new Date(fields.updated).toLocaleString()}
      
      **Описание**:\n${fields.description || 'Нет описания'}
      
      **Комментарии**:\n${commentsText || 'Нет комментариев'}
    `,
    itilcategories_id: config.glpi.defaultTicketCategory,
    _link: {
      link: {
        name: 'Jira Task',
        url: `${config.jira.baseUrl}/browse/${issue.key}`
      }
    }
  };
}

// Проверка подключения к Jira
async function checkJiraConnection() {
  try {
    const response = await axios.get(`${config.jira.baseUrl}/rest/api/2/myself`, {
      headers: {
        'Cookie': config.jira.sessionCookie,
        'X-Atlassian-Token': 'no-check'
      },
      timeout: 5000
    });
    log(`Успешное подключение к Jira как: ${response.data.displayName}`);
    return true;
  } catch (error) {
    log('Ошибка подключения к Jira:');
    if (error.response) {
      log(`HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    } else {
      log(error.message);
    }
    return false;
  }
}

// Проверка подключения к GLPI
async function checkGlpiConnection() {
  try {
    const response = await axios.get(`${config.glpi.baseUrl}/initSession`, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Authorization': `user_token ${config.glpi.userToken}`
      },
      timeout: 5000
    });
    log(`Успешное подключение к GLPI. Токен сессии: ${response.data.session_token}`);
    return true;
  } catch (error) {
    log('Ошибка подключения к GLPI:');
    if (error.response) {
      log(`URL: ${error.config.url}`);
      log(`Status: ${error.response.status}`);
      log(`Response: ${JSON.stringify(error.response.data)}`);
    } else {
      log(error.message);
    }
    return false;
  }
}

// ================== Функции для работы с GLPI ==================

// Создание сессии GLPI
async function createGlpiSession() {
  const response = await axios.get(`${config.glpi.baseUrl}/initSession`, {
    headers: {
      'App-Token': config.glpi.appToken,
      'Authorization': `user_token ${config.glpi.userToken}`
    }
  });
  return response.data.session_token;
}

// Закрытие сессии GLPI
async function killGlpiSession(sessionToken) {
  await axios.get(`${config.glpi.baseUrl}/killSession`, {
    headers: {
      'App-Token': config.glpi.appToken,
      'Session-Token': sessionToken
    }
  });
}

// Создание тикета в GLPI
async function createGlpiTicket(issue) {
  try {
    const sessionToken = await createGlpiSession();
    const comments = await getJiraComments(issue.key);
    const ticketData = { input: formatDataForGlpi(issue, comments) };

    const response = await axios.post(`${config.glpi.baseUrl}/Ticket`, ticketData, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Session-Token': sessionToken,
        'Content-Type': 'application/json'
      }
    });

    log(`Тикет создан: ID ${response.data.id} для ${issue.key}`);
    await killGlpiSession(sessionToken);

    return { ...response.data, jiraKey: issue.key };
  } catch (error) {
    log(`Ошибка при создании тикета для ${issue.key}: ${error.message}`);
    return null;
  }
}

// Обновление тикета в GLPI
async function updateGlpiTicket(glpiId, issue) {
  try {
    const sessionToken = await createGlpiSession();
    const comments = await getJiraComments(issue.key);
    const ticketData = { input: formatDataForGlpi(issue, comments) };

    const response = await axios.put(`${config.glpi.baseUrl}/Ticket/${glpiId}`, ticketData, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Session-Token': sessionToken,
        'Content-Type': 'application/json'
      }
    });

    log(`Тикет ${glpiId} обновлен для ${issue.key}`);
    await killGlpiSession(sessionToken);

    return response.data;
  } catch (error) {
    log(`Ошибка обновления тикета ${glpiId}: ${error.message}`);
    return null;
  }
}

// ================== Функции для работы с Jira ==================

// Получение всех задач из Jira (с пагинацией)
async function getAllJiraIssues(jql = 'ORDER BY created ASC') {
  let allIssues = [];
  let startAt = 0;
  let total = 1;

  try {
    log(`Начало загрузки задач по JQL: ${jql}`);
    
    while (startAt < total) {
      const response = await axios.get(`${config.jira.baseUrl}/rest/api/2/search`, {
        headers: {
          'Cookie': config.jira.sessionCookie,
          'X-Atlassian-Token': 'no-check'
        },
        params: {
          jql,
          startAt,
          maxResults: config.jira.batchSize,
          fields: config.jira.fieldsToSync.join(',')
        }
      });

      allIssues = [...allIssues, ...response.data.issues];
      total = response.data.total;
      startAt += config.jira.batchSize;

      log(`Загружено ${allIssues.length} из ${total} задач`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return allIssues;
  } catch (error) {
    log(`Ошибка при загрузке задач: ${error.message}`);
    return [];
  }
}

// Получение измененных задач из Jira
async function getUpdatedJiraIssues() {
  const state = loadSyncState();
  const jql = state.lastSync 
    ? `updated >= "${new Date(state.lastSync).toISOString().split('.')[0]}"`
    : 'updated >= -1d';

  return await getAllJiraIssues(jql);
}

// ================== Функции синхронизации ==================

// Загрузка состояния синхронизации
function loadSyncState() {
  try {
    if (fs.existsSync(config.syncStateFile)) {
      return JSON.parse(fs.readFileSync(config.syncStateFile));
    }
  } catch (error) {
    log(`Ошибка загрузки состояния: ${error.message}`);
  }
  return { lastSync: null, jiraToGlpiMap: {} };
}

// Сохранение состояния синхронизации
function saveSyncState(state) {
  try {
    fs.writeFileSync(config.syncStateFile, JSON.stringify(state, null, 2));
  } catch (error) {
    log(`Ошибка сохранения состояния: ${error.message}`);
  }
}

// Поиск соответствующего тикета в GLPI
async function findGlpiTicket(jiraKey) {
  const state = loadSyncState();
  return state.jiraToGlpiMap[jiraKey] || null;
}

// Перенос всех задач из Jira в GLPI
async function migrateAllIssues() {
  try {
    log('=== Начало миграции всех задач ===');
    
    if (!(await checkJiraConnection()) || !(await checkGlpiConnection())) {
      log('Проверка подключений не пройдена. Прерывание.');
      return;
    }

    const issues = await getAllJiraIssues();
    log(`Всего задач для переноса: ${issues.length}`);

    const state = loadSyncState();
    let createdCount = 0;

    for (const [index, issue] of issues.entries()) {
      log(`Перенос ${index + 1}/${issues.length}: ${issue.key}`);
      const result = await createGlpiTicket(issue);
      
      if (result) {
        state.jiraToGlpiMap[issue.key] = result.id;
        createdCount++;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    state.lastSync = new Date().toISOString();
    saveSyncState(state);

    log(`=== Миграция завершена. Создано тикетов: ${createdCount} ===`);
  } catch (error) {
    log(`Ошибка миграции: ${error.message}`);
  }
}

// Синхронизация измененных задач
async function syncChanges() {
  log('=== Начало синхронизации изменений ===');
  
  if (!(await checkJiraConnection()) || !(await checkGlpiConnection())) {
    log('Проверка подключений не пройдена. Прерывание.');
    return;
  }

  const issues = await getUpdatedJiraIssues();
  log(`Найдено измененных задач: ${issues.length}`);

  const state = loadSyncState();
  let updatedCount = 0;
  let createdCount = 0;

  for (const issue of issues) {
    const glpiId = await findGlpiTicket(issue.key);
    
    if (glpiId) {
      await updateGlpiTicket(glpiId, issue);
      updatedCount++;
    } else {
      log(`Для задачи ${issue.key} не найден тикет в GLPI, создаем новый`);
      const result = await createGlpiTicket(issue);
      if (result) {
        state.jiraToGlpiMap[issue.key] = result.id;
        createdCount++;
      }
    }
  }

  state.lastSync = new Date().toISOString();
  saveSyncState(state);

  log(`Обновлено тикетов: ${updatedCount}, создано новых: ${createdCount}`);
  log('=== Синхронизация завершена ===');
}

// ================== Управление скриптом ==================

// Основная функция
async function main(command = 'sync') {
  try {
    log(`Запуск скрипта с командой: ${command}`);
    
    switch (command) {
      case 'migrate':
        await migrateAllIssues();
        break;
      case 'sync':
        await syncChanges();
        break;
      default:
        log(`Неизвестная команда: ${command}`);
        log('Доступные команды: migrate, sync');
        return;
    }

    if (config.syncInterval) {
      cron.schedule(config.syncInterval, syncChanges);
      log(`Автосинхронизация настроена (${config.syncInterval})`);
    }
  } catch (error) {
    log(`Критическая ошибка: ${error.stack || error.message}`);
  }
}

// Обработка сигналов
process.on('SIGINT', () => {
  log('\nОстановка скрипта...');
  process.exit(0);
});

// Запуск
const command = process.argv[2] || 'sync';
main(command);