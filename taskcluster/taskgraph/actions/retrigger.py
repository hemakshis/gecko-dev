# -*- coding: utf-8 -*-

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from __future__ import absolute_import, print_function, unicode_literals

import json
import logging
import textwrap

from slugid import nice as slugid
from .util import (
    combine_task_graph_files,
    create_tasks,
    fetch_graph_and_labels,
    relativize_datestamps,
    create_task_from_def,
)
from ..util.parameterization import resolve_task_references
from .registry import register_callback_action

logger = logging.getLogger(__name__)


@register_callback_action(
    name='retrigger',
    cb_name='retrigger-mochitest',
    title='Retrigger Mochitest/Reftest',
    symbol='rt',
    kind='hook',
    generic=True,
    description="Retriggers the specified mochitest/reftest job with additional options",
    context=[{'test-type': 'mochitest'},
             {'test-type': 'reftest'}],
    order=10,
    schema={
        'type': 'object',
        'properties': {
            'path': {
                'type': 'string',
                'maxLength': 255,
                'default': '',
                'title': 'Path name',
                'description': 'Path of test to retrigger'
            },
            'logLevel': {
                'type': 'string',
                'enum': ['debug', 'info', 'warning', 'error', 'critical'],
                'default': 'debug',
                'title': 'Log level',
                'description': 'Log level for output (default is DEBUG, which is highest)'
            },
            'runUntilFail': {
                'type': 'boolean',
                'default': True,
                'title': 'Run until failure',
                'description': ('Runs the specified set of tests repeatedly '
                                'until failure (or 30 times)')
            },
            'repeat': {
                'type': 'integer',
                'default': 30,
                'minimum': 1,
                'title': 'Run tests N times',
                'description': ('Run tests repeatedly (usually used in '
                                'conjunction with runUntilFail)')
            },
            'environment': {
                'type': 'object',
                'default': {'MOZ_LOG': ''},
                'title': 'Extra environment variables',
                'description': 'Extra environment variables to use for this run',
                'additionalProperties': {'type': 'string'}
            },
            'preferences': {
                'type': 'object',
                'default': {'mygeckopreferences.pref': 'myvalue2'},
                'title': 'Extra gecko (about:config) preferences',
                'description': 'Extra gecko (about:config) preferences to use for this run',
                'additionalProperties': {'type': 'string'}
            }
        },
        'additionalProperties': False,
        'required': ['path']
    }
)
def mochitest_retrigger_action(parameters, graph_config, input, task_group_id, task_id, task):
    decision_task_id, full_task_graph, label_to_taskid = fetch_graph_and_labels(
        parameters, graph_config)

    pre_task = full_task_graph.tasks[task['metadata']['name']]

    # fix up the task's dependencies, similar to how optimization would
    # have done in the decision
    dependencies = {name: label_to_taskid[label]
                    for name, label in pre_task.dependencies.iteritems()}
    new_task_definition = resolve_task_references(pre_task.label, pre_task.task, dependencies)
    new_task_definition.setdefault('dependencies', []).extend(dependencies.itervalues())

    # don't want to run mozharness tests, want a custom mach command instead
    new_task_definition['payload']['command'] += ['--no-run-tests']

    custom_mach_command = [task['tags']['test-type']]

    # mochitests may specify a flavor
    if new_task_definition['payload']['env'].get('MOCHITEST_FLAVOR'):
        custom_mach_command += [
            '--keep-open=false',
            '-f',
            new_task_definition['payload']['env']['MOCHITEST_FLAVOR']
        ]

    enable_e10s = json.loads(new_task_definition['payload']['env'].get(
        'ENABLE_E10S', 'true'))
    if not enable_e10s:
        custom_mach_command += ['--disable-e10s']

    custom_mach_command += ['--log-tbpl=-',
                            '--log-tbpl-level={}'.format(input.get('logLevel', 'debug'))]
    if input.get('runUntilFail'):
        custom_mach_command += ['--run-until-failure']
    if input.get('repeat'):
        custom_mach_command += ['--repeat', str(input.get('repeat', 30))]

    # add any custom gecko preferences
    for (key, val) in input.get('preferences', {}).iteritems():
        custom_mach_command += ['--setpref', '{}={}'.format(key, val)]

    custom_mach_command += [input['path']]
    new_task_definition['payload']['env']['CUSTOM_MACH_COMMAND'] = ' '.join(
        custom_mach_command)

    # update environment
    new_task_definition['payload']['env'].update(input.get('environment', {}))

    # tweak the treeherder symbol
    new_task_definition['extra']['treeherder']['symbol'] += '-custom'

    logging.info("New task definition: %s", new_task_definition)

    # actually create the new task
    new_task_id = slugid()
    create_task_from_def(new_task_id, new_task_definition, parameters['level'])


@register_callback_action(
    title='Retrigger',
    name='retrigger',
    symbol='rt',
    kind='hook',
    cb_name='retrigger-decision',
    description=textwrap.dedent('''\
        Create a clone of the task (retriggering decision, action, and cron tasks requires
        special scopes).'''),
    order=11,
    context=[
        {'kind': 'decision-task'},
        {'kind': 'action-callback'},
        {'kind': 'cron-task'},
    ],
)
def retrigger_decision_action(parameters, graph_config, input, task_group_id, task_id, task):
    decision_task_id, full_task_graph, label_to_taskid = fetch_graph_and_labels(
        parameters, graph_config)
    """For a single task, we try to just run exactly the same task once more.
    It's quite possible that we don't have the scopes to do so (especially for
    an action), but this is best-effort."""

    # make all of the timestamps relative; they will then be turned back into
    # absolute timestamps relative to the current time.
    task = relativize_datestamps(task)
    create_task_from_def(slugid(), task, parameters['level'])


@register_callback_action(
    title='Retrigger',
    name='retrigger',
    symbol='rt',
    kind='hook',
    generic=True,
    description=(
        'Create a clone of the task.'
    ),
    order=19,  # must be greater than other orders in this file, as this is the fallback version
    context=[{}],
    schema={
        'type': 'object',
        'properties': {
            'downstream': {
                'type': 'boolean',
                'description': (
                    'If true, downstream tasks from this one will be cloned as well. '
                    'The dependencies will be updated to work with the new task at the root.'
                ),
                'default': False,
            },
            'times': {
                'type': 'integer',
                'default': 1,
                'minimum': 1,
                'maximum': 6,
                'title': 'Times',
                'description': 'How many times to run each task.',
            }
        }
    }
)
def retrigger_action(parameters, graph_config, input, task_group_id, task_id, task):
    decision_task_id, full_task_graph, label_to_taskid = fetch_graph_and_labels(
        parameters, graph_config)

    label = task['metadata']['name']

    with_downstream = ' '
    to_run = [label]

    if input.get('downstream'):
        to_run = full_task_graph.graph.transitive_closure(set(to_run), reverse=True).nodes
        to_run = to_run & set(label_to_taskid.keys())
        with_downstream = ' (with downstream) '

    times = input.get('times', 1)
    for i in xrange(times):
        create_tasks(to_run, full_task_graph, label_to_taskid, parameters, decision_task_id, i)

        logger.info('Scheduled {}{}(time {}/{})'.format(label, with_downstream, i+1, times))
    combine_task_graph_files(list(range(times)))
