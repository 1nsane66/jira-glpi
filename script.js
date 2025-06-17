const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// Общая конфигурация
const config = {
  jira: {
    baseUrl: 'https://jira-stud.udv.group',
    // Используйте базовую авторизацию вместо куки (рекомендуется)
    auth: {
      username: 'azacharov',
      password: 'P@ssw0rd321'
    },
    batchSize: 100,
    fieldsToSync: ['summary', 'status', 'assignee', 'creator', 'created', 'updated', 'comment'],
    // Убедитесь, что эти значения корректны для вашего Jira!
    defaultProjectKey: 'DL',  // Замените на реальный ключ проекта
    defaultIssueType: 'Task'     // Замените на реальный тип задачи
  },
  glpi: {
    baseUrl: 'http://10.51.4.2/glpi/apirest.php',
    appToken: 'x9K5pICuWiC0yOIyO0XiHslo4k2qZHy4D8ndgeXE',
    userToken: 'UWqcbVIi8Iebwayt2RuUy5DfUASgIIL8dZHKTK7R',
    defaultTicketCategory: 1,
    ticketStatusMap: {
      'Новый': '1',
      'В работе': '2',
      'Решен': '3',
      'Закрыт': '5'
    }
  },
  syncStateFile: 'sync-state.json',
  syncInterval: '*/30 * * * *', // Каждые 30 минут
  debug: true,
  syncDirection: 'both' // 'jira-to-glpi', 'glpi-to-jira', 'both'
};

// Логирование
function log(message) {
  const timestamp = new Date().toISOString();
  if (config.debug) {
    console.log(`[${timestamp}] ${message}`);
  }
}

// ================== Общие функции ==================

// Загрузка состояния синхронизации
function loadSyncState() {
  try {
    if (fs.existsSync(config.syncStateFile)) {
      return JSON.parse(fs.readFileSync(config.syncStateFile));
    }
  } catch (error) {
    log(`Ошибка загрузки состояния: ${error.message}`);
  }
  return { 
    lastSync: null, 
    jiraToGlpiMap: {},
    glpiToJiraMap: {},
    lastJiraSync: null,
    lastGlpiSync: null
  };
}

// Сохранение состояния синхронизации
function saveSyncState(state) {
  try {
    fs.writeFileSync(config.syncStateFile, JSON.stringify(state, null, 2));
  } catch (error) {
    log(`Ошибка сохранения состояния: ${error.message}`);
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

// Получение всех тикетов из GLPI
async function getAllGlpiTickets(updatedAfter = null) {
  try {
    const sessionToken = await createGlpiSession();
    let queryParams = {
      'range': `0-${config.jira.batchSize}`,
      // Убрали параметр sort, так как он вызывает ошибку
      'order': 'ASC'
    };

    if (updatedAfter) {
      queryParams['search'] = JSON.stringify({
        'date_mod': {
          'after': updatedAfter
        }
      });
    }

    const response = await axios.get(`${config.glpi.baseUrl}/Ticket`, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Session-Token': sessionToken
      },
      params: queryParams
    });

    await killGlpiSession(sessionToken);
    return response.data || [];
  } catch (error) {
    log(`Ошибка при получении тикетов из GLPI: ${error.message}`);
    if (error.response) {
      log(`Детали ошибки: ${JSON.stringify(error.response.data)}`);
    }
    return [];
  }
}

// Получение полной информации о тикете GLPI
async function getGlpiTicketDetails(ticketId) {
  try {
    const sessionToken = await createGlpiSession();
    
    // Получаем основную информацию о тикете
    const ticketResponse = await axios.get(`${config.glpi.baseUrl}/Ticket/${ticketId}`, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Session-Token': sessionToken
      }
    });

    // Получаем комментарии
    const commentsResponse = await axios.get(`${config.glpi.baseUrl}/Ticket/${ticketId}/ITILFollowup`, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Session-Token': sessionToken
      }
    });

    await killGlpiSession(sessionToken);

    return {
      ...ticketResponse.data,
      comments: commentsResponse.data || []
    };
  } catch (error) {
    log(`Ошибка при получении деталей тикета ${ticketId}: ${error.message}`);
    return null;
  }
}

// Форматирование данных для Jira
function formatDataForJira(ticket) {
  return {
    fields: {
      project: {
        key: config.jira.defaultProjectKey
      },
      issuetype: {
        name: config.jira.defaultIssueType
      },
      summary: `GLPI-${ticket.id}: ${ticket.name || 'Без названия'}`.substring(0, 255),
      description: `
        **Тикет GLPI**: ${ticket.id}
        **Статус**: ${ticket.status}
        **Содержание**:\n${ticket.content || 'Нет содержимого'}
      `.trim()
    }
  };
}

// Извлечение ключа Jira из названия тикета
function extractJiraKey(name) {
  const match = name.match(/([A-Z]+-\d+)/);
  return match ? match[0] : null;
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
  const jql = state.lastJiraSync 
    ? `updated >= "${new Date(state.lastJiraSync).toISOString().split('.')[0]}"`
    : 'updated >= -1d';

  return await getAllJiraIssues(jql);
}

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

// Создание задачи в Jira
// Создание задачи в Jira
async function createJiraIssue(ticket) {
  try {
    const issueData = {
      fields: {
        project: {
          key: config.jira.defaultProjectKey
        },
        issuetype: {
          name: config.jira.defaultIssueType
        },
        summary: `GLPI-${ticket.id}: ${ticket.name || 'Без названия'}`.substring(0, 255),
        description: `
          Импортировано из GLPI
          ID: ${ticket.id}
          Статус: ${ticket.status}
          Содержание: ${ticket.content || 'Нет содержимого'}
        `
      }
    };

    console.log('Отправка в Jira:', JSON.stringify(issueData, null, 2));

    const response = await axios.post(`${config.jira.baseUrl}/rest/api/2/issue`, issueData, {
      auth: config.jira.auth,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    log(`Задача создана: ${response.data.key}`);
    return response.data;
  } catch (error) {
    log(`Ошибка создания задачи: ${error.response?.data?.errorMessages?.join(', ') || error.message}`);
    console.error('Детали ошибки:', error.response?.data);
    return null;
  }
}

// Обновление задачи в Jira
async function updateJiraIssue(issueKey, ticket) {
  try {
    const issueData = formatDataForJira(ticket);
    
    const response = await axios.put(`${config.jira.baseUrl}/rest/api/2/issue/${issueKey}`, issueData, {
      headers: {
        'Cookie': config.jira.sessionCookie,
        'X-Atlassian-Token': 'no-check',
        'Content-Type': 'application/json'
      }
    });

    log(`Задача ${issueKey} обновлена в Jira для GLPI-${ticket.id}`);
    return response.data;
  } catch (error) {
    log(`Ошибка при обновлении задачи ${issueKey} в Jira: ${error.message}`);
    return null;
  }
}

// ================== Функции синхронизации ==================

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

// Синхронизация из Jira в GLPI
async function syncJiraToGlpi() {
  log('=== Начало синхронизации Jira → GLPI ===');
  
  const issues = await getUpdatedJiraIssues();
  log(`Найдено измененных задач в Jira: ${issues.length}`);

  const state = loadSyncState();
  let updatedCount = 0;
  let createdCount = 0;

  for (const issue of issues) {
    const glpiId = state.jiraToGlpiMap[issue.key];
    
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

  state.lastJiraSync = new Date().toISOString();
  saveSyncState(state);

  log(`Обновлено тикетов: ${updatedCount}, создано новых: ${createdCount}`);
  log('=== Синхронизация Jira → GLPI завершена ===');
}

// Синхронизация из GLPI в Jira
async function syncGlpiToJira() {
  log('=== Начало синхронизации GLPI → Jira ===');
  
  const state = loadSyncState();
  const updatedAfter = state.lastGlpiSync ? new Date(state.lastGlpiSync) : null;
  
  const tickets = await getAllGlpiTickets(updatedAfter);
  log(`Найдено измененных тикетов в GLPI: ${tickets.length}`);

  let updatedCount = 0;
  let createdCount = 0;

  for (const ticket of tickets) {
    const ticketDetails = await getGlpiTicketDetails(ticket.id);
    if (!ticketDetails) continue;
    
    const jiraKey = state.glpiToJiraMap[ticket.id] || extractJiraKey(ticketDetails.name);
    
    if (jiraKey) {
      await updateJiraIssue(jiraKey, ticketDetails);
      updatedCount++;
    } else {
      log(`Для тикета GLPI-${ticket.id} не найдена задача в Jira, создаем новую`);
      const result = await createJiraIssue(ticketDetails);
      if (result) {
        state.glpiToJiraMap[ticket.id] = result.key;
        createdCount++;
      }
    }
  }

  state.lastGlpiSync = new Date().toISOString();
  saveSyncState(state);

  log(`Обновлено задач: ${updatedCount}, создано новых: ${createdCount}`);
  log('=== Синхронизация GLPI → Jira завершена ===');
}

// Полная двусторонняя синхронизация
async function fullSync() {
  if (config.syncDirection === 'both' || config.syncDirection === 'jira-to-glpi') {
    await syncJiraToGlpi();
  }
  
  if (config.syncDirection === 'both' || config.syncDirection === 'glpi-to-jira') {
    await syncGlpiToJira();
  }
}

// Перенос всех задач из Jira в GLPI
async function migrateAllFromJira() {
  try {
    log('=== Начало миграции всех задач из Jira ===');
    
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

    state.lastJiraSync = new Date().toISOString();
    saveSyncState(state);

    log(`=== Миграция завершена. Создано тикетов: ${createdCount} ===`);
  } catch (error) {
    log(`Ошибка миграции: ${error.message}`);
  }
}

// Перенос всех тикетов из GLPI в Jira
async function migrateAllFromGlpi() {
  try {
    log('=== Начало миграции всех тикетов из GLPI ===');
    
    const tickets = await getAllGlpiTickets();
    log(`Всего тикетов для переноса: ${tickets.length}`);

    const state = loadSyncState();
    // Инициализируем glpiToJiraMap, если он undefined
    if (!state.glpiToJiraMap) {
      state.glpiToJiraMap = {};
    }
    
    let createdCount = 0;

    for (const [index, ticket] of tickets.entries()) {
      log(`Перенос ${index + 1}/${tickets.length}: GLPI-${ticket.id}`);
      const ticketDetails = await getGlpiTicketDetails(ticket.id);
      if (!ticketDetails) continue;
      
      const result = await createJiraIssue(ticketDetails);
      
      if (result && result.key) {
        state.glpiToJiraMap[ticket.id] = result.key;
        createdCount++;
        saveSyncState(state); // Сохраняем после каждого успешного создания
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    state.lastGlpiSync = new Date().toISOString();
    saveSyncState(state);

    log(`=== Миграция завершена. Создано задач: ${createdCount} ===`);
  } catch (error) {
    log(`Ошибка миграции: ${error.message}`);
    if (error.stack) {
      log(`Стек ошибки: ${error.stack}`);
    }
  }
}

// ================== Управление скриптом ==================

async function main(command = 'sync') {
  try {
    log(`Запуск скрипта с командой: ${command}`);
    
    switch (command) {
      case 'migrate-jira':
        await migrateAllFromJira();
        break;
      case 'migrate-glpi':
        await migrateAllFromGlpi();
        break;
      case 'sync':
        await fullSync();
        break;
      case 'jira-to-glpi':
        await syncJiraToGlpi();
        break;
      case 'glpi-to-jira':
        await syncGlpiToJira();
        break;
      default:
        log(`Неизвестная команда: ${command}`);
        log('Доступные команды: migrate-jira, migrate-glpi, sync, jira-to-glpi, glpi-to-jira');
        return;
    }

    if (config.syncInterval && command === 'sync') {
      cron.schedule(config.syncInterval, fullSync);
      log(`Автосинхронизация настроена (${config.syncInterval})`);
    }
  } catch (error) {
    log(`Критическая ошибка: ${error.stack || error.message}`);
  }
}

// ================== Проверка состояния перед сохранением ==================
function saveSyncState(state) {
  try {
    if (!state) {
      log('Попытка сохранить undefined состояние');
      return;
    }
    fs.writeFileSync(config.syncStateFile, JSON.stringify(state, null, 2));
  } catch (error) {
    log(`Ошибка сохранения состояния: ${error.message}`);
  }
}

process.on('SIGINT', () => {
  log('\nОстановка скрипта...');
  process.exit(0);
});

const command = process.argv[2] || 'sync';
main(command);