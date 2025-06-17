const axios = require('axios');
const cron = require('node-cron');

// Конфигурация
const config = {
  jira: {
    baseUrl: 'https://jira-stud.udv.group',
    sessionCookie: 'JSESSIONID=9BB0B75DC4316E75F15063AF2179752F',
    jql: 'ORDER BY created ASC', // Получаем все задачи с сортировкой по дате создания
    batchSize: 100, // Увеличиваем размер выборки
    fieldsToSync: ['summary', 'status', 'assignee', 'creator', 'created', 'updated', 'comment']
  },
  glpi: {
    baseUrl: 'http://10.51.4.2/glpi/apirest.php',
    appToken: 'x9K5pICuWiC0yOIyO0XiHslo4k2qZHy4D8ndgeXE',
    userToken: 'UWqcbVIi8Iebwayt2RuUy5DfUASgIIL8dZHKTK7R',
    defaultTicketCategory: 1
  },
  debug: true
};

// Логирование
function log(message) {
  const timestamp = new Date().toISOString();
  if (config.debug) {
    console.log(`[${timestamp}] ${message}`);
  }
}

// Получение всех задач из Jira (с пагинацией)
async function getAllJiraIssues() {
  let allIssues = [];
  let startAt = 0;
  let total = 1; // Инициализируем для первого входа в цикл

  try {
    log('Начало загрузки всех задач из Jira...');
    
    while (startAt < total) {
      const response = await axios.get(`${config.jira.baseUrl}/rest/api/2/search`, {
        headers: {
          'Cookie': config.jira.sessionCookie,
          'X-Atlassian-Token': 'no-check'
        },
        params: {
          jql: config.jira.jql,
          startAt,
          maxResults: config.jira.batchSize,
          fields: 'summary,status,assignee,creator,created,updated,comment'
        }
      });

      allIssues = [...allIssues, ...response.data.issues];
      total = response.data.total;
      startAt += config.jira.batchSize;

      log(`Загружено ${allIssues.length} из ${total} задач`);
      
      // Пауза между запросами чтобы не перегружать сервер
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return allIssues;
  } catch (error) {
    log(`Ошибка при загрузке задач: ${error.message}`);
    return [];
  }
}

// Получение комментариев (без изменений)
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

// Форматирование данных для GLPI (без изменений)
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

// Создание тикета в GLPI (без изменений)
async function createGlpiTicket(issue) {
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

    const response = await axios.post(`${config.glpi.baseUrl}/Ticket`, ticketData, {
      headers: {
        'App-Token': config.glpi.appToken,
        'Session-Token': sessionToken,
        'Content-Type': 'application/json'
      }
    });

    log(`Тикет создан: ID ${response.data.id} для ${issue.key}`);
    
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

// Основная функция для переноса всех задач
async function migrateAllIssues() {
  try {
    log('=== Начало миграции всех задач ===');
    
    const issues = await getAllJiraIssues();
    log(`Всего задач для переноса: ${issues.length}`);

    for (const [index, issue] of issues.entries()) {
      log(`Перенос ${index + 1}/${issues.length}: ${issue.key}`);
      await createGlpiTicket(issue);
      
      // Пауза между запросами
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    log('=== Миграция завершена ===');
  } catch (error) {
    log(`Ошибка миграции: ${error.message}`);
  }
}

// Запуск
migrateAllIssues();