const axios = require('axios');
const cron = require('node-cron');

// Конфигурация
const config = {
  jira: {
    baseUrl: 'https://jira-stud.udv.group',
    sessionCookie: 'JSESSIONID=9BB0B75DC4316E75F15063AF2179752F',
    jql: 'updated >= -1d',
    batchSize: 50,
    fieldsToSync: ['summary', 'status', 'assignee', 'creator', 'created', 'updated', 'comment']
  },
  glpi: {
    baseUrl: 'http://10.51.4.2/glpi/apirest.php',
    appToken: 'x9K5pICuWiC0yOIyO0XiHslo4k2qZHy4D8ndgeXE',
    userToken: 'UWqcbVIi8Iebwayt2RuUy5DfUASgIIL8dZHKTK7R',
    defaultTicketCategory: 1
  },
  syncInterval: '*/30 * * * *',
  debug: true
};

// Логирование
function log(message) {
  const timestamp = new Date().toISOString();
  if (config.debug) {
    console.log(`[${timestamp}] ${message}`);
  }
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

// Проверка подключения к Jira (без изменений)
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

// Проверка подключения к GLPI (обновлено)
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

// Получение задач из Jira (без изменений)
async function getJiraIssues() {
  try {
    const response = await axios.get(`${config.jira.baseUrl}/rest/api/2/search`, {
      headers: {
        'Cookie': config.jira.sessionCookie,
        'X-Atlassian-Token': 'no-check'
      },
      params: {
        jql: config.jira.jql,
        maxResults: config.jira.batchSize
      },
      timeout: 10000
    });
    return response.data.issues || [];
  } catch (error) {
    log('Ошибка при запросе задач из Jira:');
    if (error.response) {
      log(`Status: ${error.response.status}`);
      log(`Response: ${JSON.stringify(error.response.data)}`);
    } else {
      log(error.message);
    }
    return [];
  }
}

// Создание тикета в GLPI (обновленная версия)
async function createGlpiTicket(issue) {
  try {
    // Получаем сессию GLPI
    const sessionResponse = await axios.get(`${config.glpi.baseUrl}/initSession`, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Authorization': `user_token ${config.glpi.userToken}`
      }
    });
    const sessionToken = sessionResponse.data.session_token;

    // Получаем комментарии из Jira
    const comments = await getJiraComments(issue.key);

    // Формируем данные для GLPI
    const ticketData = {
      input: formatDataForGlpi(issue, comments)
    };

    // Создаем тикет
    const response = await axios.post(`${config.glpi.baseUrl}/Ticket`, ticketData, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Session-Token': sessionToken,
        'Content-Type': 'application/json'
      }
    });

    log(`Тикет создан: ID ${response.data.id}`);
    
    // Закрываем сессию GLPI
    await axios.get(`${config.glpi.baseUrl}/killSession`, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Session-Token': sessionToken
      }
    });

    return response.data;
  } catch (error) {
    log(`Ошибка при создании тикета для ${issue.key}: ${error.message}`);
    return null;
  }
}

// Основная функция синхронизации
async function syncJiraToGlpi() {
  log('=== Начало синхронизации ===');
  
  if (!(await checkJiraConnection())) {
    log('Проверка Jira не пройдена. Прерывание.');
    return;
  }

  if (!(await checkGlpiConnection())) {
    log('Проверка GLPI не пройдена. Прерывание.');
    return;
  }

  const issues = await getJiraIssues();
  log(`Найдено задач: ${issues.length}`);

  for (const [index, issue] of issues.entries()) {
    log(`Обработка ${index + 1}/${issues.length}: ${issue.key}`);
    await createGlpiTicket(issue);
    await new Promise(resolve => setTimeout(resolve, 500)); // Пауза
  }

  log('=== Синхронизация завершена ===\n');
}

// Управление скриптом
async function main() {
  try {
    log('Запуск скрипта синхронизации Jira → GLPI');
    await syncJiraToGlpi();
    
    if (config.syncInterval) {
      cron.schedule(config.syncInterval, syncJiraToGlpi);
      log(`Автосинхронизация настроена (${config.syncInterval})`);
    }
  } catch (error) {
    log(`Критическая ошибка: ${error.stack || error.message}`);
  }
}

process.on('SIGINT', () => {
  log('\nОстановка скрипта...');
  process.exit(0);
});

main();