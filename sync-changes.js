const axios = require('axios');
const fs = require('fs');
const cron = require('node-cron');

// Конфигурация
const config = {
  jira: {
    baseUrl: 'https://jira-stud.udv.group',
    sessionCookie: 'JSESSIONID=9BB0B75DC4316E75F15063AF2179752F',
    jql: 'updated >= -1d', // Задачи, измененные за последний день
    batchSize: 100,
    fieldsToSync: ['summary', 'status', 'assignee', 'creator', 'created', 'updated', 'comment']
  },
  glpi: {
    baseUrl: 'http://10.51.4.2/glpi/apirest.php',
    appToken: 'x9K5pICuWiC0yOIyO0XiHslo4k2qZHy4D8ndgeXE',
    userToken: 'UWqcbVIi8Iebwayt2RuUy5DfUASgIIL8dZHKTK7R',
    defaultTicketCategory: 1
  },
  syncStateFile: 'sync-state.json', // Файл для хранения состояния синхронизации
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

// Получение измененных задач из Jira
async function getUpdatedJiraIssues() {
  const state = loadSyncState();
  const jql = state.lastSync 
    ? `updated >= "${new Date(state.lastSync).toISOString().split('.')[0]}"`
    : config.jira.jql;

  try {
    const response = await axios.get(`${config.jira.baseUrl}/rest/api/2/search`, {
      headers: {
        'Cookie': config.jira.sessionCookie,
        'X-Atlassian-Token': 'no-check'
      },
      params: {
        jql,
        maxResults: config.jira.batchSize,
        fields: config.jira.fieldsToSync.join(',')
      }
    });
    return response.data.issues || [];
  } catch (error) {
    log(`Ошибка получения задач: ${error.message}`);
    return [];
  }
}

// Поиск соответствующего тикета в GLPI
async function findGlpiTicket(jiraKey) {
  const state = loadSyncState();
  if (state.jiraToGlpiMap[jiraKey]) {
    return state.jiraToGlpiMap[jiraKey];
  }
  return null;
}

// Обновление тикета в GLPI
async function updateGlpiTicket(glpiId, issue) {
  try {
    const sessionResponse = await axios.get(`${config.glpi.baseUrl}/initSession`, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Authorization': `user_token ${config.glpi.userToken}`
      }
    });
    const sessionToken = sessionResponse.data.session_token;

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
    
    await axios.get(`${config.glpi.baseUrl}/killSession`, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Session-Token': sessionToken
      }
    });

    return response.data;
  } catch (error) {
    log(`Ошибка обновления тикета ${glpiId}: ${error.message}`);
    return null;
  }
}

// Синхронизация изменений
async function syncChanges() {
  log('=== Начало синхронизации изменений ===');
  
  const issues = await getUpdatedJiraIssues();
  log(`Найдено измененных задач: ${issues.length}`);

  const state = loadSyncState();
  let updatedCount = 0;

  for (const issue of issues) {
    const glpiId = await findGlpiTicket(issue.key);
    if (glpiId) {
      await updateGlpiTicket(glpiId, issue);
      updatedCount++;
    } else {
      log(`Для задачи ${issue.key} не найден соответствующий тикет в GLPI`);
    }
  }

  // Обновляем время последней синхронизации
  state.lastSync = new Date().toISOString();
  saveSyncState(state);

  log(`Обновлено тикетов: ${updatedCount}`);
  log('=== Синхронизация завершена ===');
}

// Инициализация
async function main() {
  try {
    await syncChanges();
    
    if (config.syncInterval) {
      cron.schedule(config.syncInterval, syncChanges);
      log(`Автосинхронизация настроена (${config.syncInterval})`);
    }
  } catch (error) {
    log(`Ошибка: ${error.message}`);
  }
}

process.on('SIGINT', () => {
  log('\nОстановка скрипта...');
  process.exit(0);
});

main();