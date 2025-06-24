const fs = require('fs');
const prompts = require('prompts');

async function setupConfig() {
    const questions = [
        {
            type: 'text',
            name: 'jiraUrl',
            message: 'Jira URL:',
            initial: 'https://jira-stud.udv.group'
        },
        {
            type: 'text',
            name: 'jiraUser',
            message: 'Jira Username:',
            initial: 'azacharov'
        },
        {
            type: 'password',
            name: 'jiraPass',
            message: 'Jira Password/Token:'
        },
        {
            type: 'text',
            name: 'jiraProject',
            message: 'Jira Project Key:',
            initial: 'DL'
        },
        {
            type: 'text',
            name: 'jiraIssueType',
            message: 'Jira Issue Type:',
            initial: 'Task'
        },
        {
            type: 'text',
            name: 'glpiUrl',
            message: 'GLPI API URL:',
            initial: 'http://10.51.4.2/glpi/apirest.php'
        },
        {
            type: 'password',
            name: 'glpiAppToken',
            message: 'GLPI App Token:'
        },
        {
            type: 'password',
            name: 'glpiUserToken',
            message: 'GLPI User Token:'
        },
        {
            type: 'select',
            name: 'syncDirection',
            message: 'Sync Direction:',
            choices: [
                { title: 'Both ways', value: 'both' },
                { title: 'Jira to GLPI only', value: 'jira-to-glpi' },
                { title: 'GLPI to Jira only', value: 'glpi-to-jira' }
            ],
            initial: 0
        },
        {
            type: 'text',
            name: 'syncInterval',
            message: 'Sync Interval (cron):',
            initial: '*/30 * * * *'
        }
    ];

    const response = await prompts(questions);
    
    const config = {
        jira: {
            baseUrl: response.jiraUrl,
            auth: {
                username: response.jiraUser,
                password: response.jiraPass
            },
            defaultProjectKey: response.jiraProject,
            defaultIssueType: response.jiraIssueType
        },
        glpi: {
            baseUrl: response.glpiUrl,
            appToken: response.glpiAppToken,
            userToken: response.glpiUserToken
        },
        sync: {
            direction: response.syncDirection,
            interval: response.syncInterval
        }
    };

    fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
    console.log('Configuration saved to config.json');
}

setupConfig();