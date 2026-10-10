import React, { useEffect, useState } from 'react';
import {
    Box, H4, Text, Button, Loader, MessageBox,
    Table, TableBody, TableRow, TableCell,
} from '@adminjs/design-system';
import { ApiClient, useNotice } from 'adminjs';

const api = new ApiClient();

const CountTable = ({ title, rows }) => (
    <Box mb="xl">
        <H4>{title}</H4>
        <Table>
            <TableBody>
                {rows.map((r) => (
                    <TableRow key={r.label}>
                        <TableCell>{r.label}</TableCell>
                        <TableCell style={{ textAlign: 'right', fontWeight: 600 }}>{r.count}</TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    </Box>
);

const MemberDeleteConfirm = ({ resource, record }) => {
    const [impact, setImpact] = useState(null);
    const [loading, setLoading] = useState(true);
    const [deleting, setDeleting] = useState(false);
    const addNotice = useNotice();

    const params = { resourceId: resource.id, recordId: record.id };

    useEffect(() => {
        api.recordAction({ ...params, actionName: 'deletePreview' })
            .then((res) => {
                if (res.data.notice) addNotice(res.data.notice);
                setImpact(res.data.impact || null);
            })
            .catch(() => addNotice({ message: 'Could not load delete preview.', type: 'error' }))
            .finally(() => setLoading(false));
    }, [record.id]);

    const confirmDelete = async () => {
        setDeleting(true);
        try {
            const res = await api.recordAction({ ...params, actionName: 'delete', method: 'post' });
            const { notice, redirectUrl } = res.data;
            if (notice) addNotice(notice);
            if (notice?.type !== 'error' && redirectUrl) window.location.assign(redirectUrl);
        } catch (err) {
            addNotice({ message: err.message || 'Delete failed.', type: 'error' });
        } finally {
            setDeleting(false);
        }
    };

    if (loading) return <Box flex justifyContent="center" p="xxl"><Loader /></Box>;
    if (!impact) return <MessageBox variant="danger" message="Could not load this record's details." />;

    return (
        <Box variant="white" p="xl">
            <H4>Permanently delete {impact.user.name}?</H4>

            {impact.blocked ? (
                <Box my="lg">
                    <MessageBox variant="danger" message="Cannot permanently delete" />
                    <Text mt="default">{impact.blockedMessage}</Text>
                    <CountTable title="Blocking content" rows={impact.blockers} />
                </Box>
            ) : (
                <>
                    <MessageBox
                        my="lg"
                        variant="warning"
                        message="This cannot be undone. The records below will be permanently deleted."
                    />
                    <Text mb="xl">
                        {impact.device
                            ? `A command will also be queued to remove PIN ${impact.device.devicePin} from device ${impact.device.deviceSN}.`
                            : 'This user has no device enrollment, so nothing will be removed from a device.'}
                    </Text>

                    {impact.willDelete.length > 0
                        ? <CountTable title="Will be deleted" rows={impact.willDelete} />
                        : <Text mb="xl">No related records will be deleted.</Text>}

                    {impact.willDetach.length > 0 && (
                        <CountTable title="Will be kept but unlinked" rows={impact.willDetach} />
                    )}
                </>
            )}

            <Box flex mt="xl">
                <Button variant="text" mr="default" onClick={() => window.history.back()} disabled={deleting}>
                    Cancel
                </Button>
                {!impact.blocked && (
                    <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
                        {deleting ? 'Deleting…' : 'Delete everything'}
                    </Button>
                )}
            </Box>
        </Box>
    );
};

export default MemberDeleteConfirm;